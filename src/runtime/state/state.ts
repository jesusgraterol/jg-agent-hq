import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';

import {
  ensurePrivateRuntimeDirectory,
  HqLockOwnerSchema,
  isPrivateOwner,
  type IHqLockOwner,
} from '../../locks/index.js';

import { ACTION_KEY_FILE, DATABASE_FILE, RUNTIME_OWNER_FILE } from './constants.js';

/**
 * Reads a private regular file with one extra byte for caller-owned size validation.
 * @throws
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 */
const readPrivateBytes = async (path: string, maximumBytes: number): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || !isPrivateOwner(details))
      throw new Exception('The HQ state file is unsafe', {
        code: 'JG_AGENT_HQ_STATE_FILE_UNSAFE',
        data: { kind: 'state-conflict' },
      });
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
};

/**
 * Keeps secret response fingerprints resistant to dictionary attacks on an exported database.
 * @returns The private per-store HMAC key; it must be retained with any SQLite backup.
 * @throws
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const prepareActionKey = async (
  stateRoot: string,
  databasePath: string,
): Promise<Uint8Array> => {
  const path = join(stateRoot, ACTION_KEY_FILE);
  try {
    const key = await readPrivateBytes(path, 32);
    if (key.length !== 32)
      throw new Exception('The HQ action key is unavailable', {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: {
          kind: 'state-conflict',
        },
      });
    return key;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      if (isException(error)) throw error;
      throw new Exception(`The HQ action key is unavailable: ${extractMessage(error)}`, {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
        cause: error,
      });
    }
  }
  if ((await lstat(databasePath)).size !== 0)
    throw new Exception('The HQ action key is unavailable', {
      code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
      data: { kind: 'state-conflict' },
    });
  const key = randomBytes(32);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(key);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return key;
};

/**
 * Canonicalizes a configured root after the shared private-directory checks.
 * @returns The absolute private state directory.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 */
export const prepareStateRoot = async (stateRoot: string): Promise<string> => {
  if (!isAbsolute(stateRoot))
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  await ensurePrivateRuntimeDirectory(stateRoot);
  return realpath(stateRoot);
};

/** Checks a canonical target with platform-aware path semantics. */
export const isWithinWorkspace = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

/**
 * Resolves each allowed workspace once at startup, with no path-based authority from the client.
 * @returns Canonical allowed workspace roots.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const resolveAllowedRoots = async (roots: string[]): Promise<string[]> => {
  if (!roots.length || roots.length > 128 || roots.some((root) => !isAbsolute(root)))
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const result: string[] = [];
  for (const root of roots) {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory())
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
};

/**
 * Validates a client target before a native read, including symlink resolution.
 * @returns Its authorized canonical path.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 */
export const resolveWorkspaceTarget = async (
  target: string,
  allowedRoots: string[],
): Promise<string> => {
  if (!isAbsolute(target))
    throw new Exception('The HQ target is outside the allowed workspaces', {
      code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
      data: {
        kind: 'access-denied',
      },
    });
  const canonical = await realpath(target);
  if (!allowedRoots.some((root) => isWithinWorkspace(root, canonical)))
    throw new Exception('The HQ target is outside the allowed workspaces', {
      code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
      data: {
        kind: 'access-denied',
      },
    });
  return canonical;
};

/**
 * Reads only the bounded, private lifetime record. It never creates/reclaims state.
 * @returns The current owner and its exact serialized record.
 * @throws
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 */
export const readRuntimeOwner = async (
  stateRoot: string,
): Promise<{ owner: IHqLockOwner; content: string }> => {
  try {
    const directory = await lstat(stateRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !isPrivateOwner(directory))
      throw new Exception('The HQ state directory is unsafe', {
        code: 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE',
        data: {
          kind: 'state-conflict',
        },
      });
    const buffer = await readPrivateBytes(join(stateRoot, RUNTIME_OWNER_FILE), 16_384);
    if (buffer.length > 16_384)
      throw new Exception('The HQ runtime owner is unverifiable', {
        code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
        data: {
          kind: 'state-conflict',
        },
      });
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const owner = HqLockOwnerSchema.safeParse(JSON.parse(content));
    if (!owner.success)
      throw new Exception('The HQ runtime owner is unverifiable', {
        code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
        data: { kind: 'state-conflict' },
        cause: owner.error,
      });
    return { owner: owner.data, content };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      throw new Exception('The HQ runtime is not running', {
        code: 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
        data: { kind: 'agent-unavailable' },
        cause: error,
      });
    if (isException(error)) throw error;
    throw new Exception(`The HQ runtime owner is unverifiable: ${extractMessage(error)}`, {
      code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
      data: { kind: 'state-conflict' },
      cause: error,
    });
  }
};

/**
 * Claims lifetime ownership exclusively, without treating process death as permission to reclaim.
 * @returns The owner and its exact-owner cleanup operation.
 * @throws
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 */
export const claimRuntimeOwner = async (stateRoot: string) => {
  const owner: IHqLockOwner = {
    pid: process.pid,
    nonce: randomUUID(),
    command: 'serve',
    createdAt: new Date().toISOString(),
  };
  const content = `${JSON.stringify(owner)}\n`;
  const path = join(stateRoot, RUNTIME_OWNER_FILE);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    await readRuntimeOwner(stateRoot);
    throw new Exception('The HQ runtime is already owned', {
      code: 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
      data: { kind: 'state-conflict' },
    });
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    owner,
    async release(): Promise<void> {
      const current = await readRuntimeOwner(stateRoot);
      if (current.content !== content)
        throw new Exception('The HQ runtime owner is unverifiable', {
          code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
          data: {
            kind: 'state-conflict',
          },
        });
      await rm(path);
    },
  };
};

/**
 * Creates the SQLite file privately and verifies its existing sidecars before the worker opens it.
 * @returns The trusted database path.
 * @throws
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 */
export const prepareDatabase = async (stateRoot: string): Promise<string> => {
  const path = join(stateRoot, DATABASE_FILE);
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  for (const filename of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      const details = await lstat(filename);
      if (
        !details.isFile() ||
        details.nlink !== 1 ||
        details.isSymbolicLink() ||
        !isPrivateOwner(details)
      )
        throw new Exception('The HQ state file is unsafe', {
          code: 'JG_AGENT_HQ_STATE_FILE_UNSAFE',
          data: { kind: 'state-conflict' },
        });
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return path;
};
