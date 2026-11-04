import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Exception, extractMessage, hasErrorCode } from 'jg-exception';
import { ERRORS as FS_ERRORS, isPathWithin, readPrivateFile } from 'jg-fs';
import {
  acquireLock,
  inspectLock,
  type ILock,
  type ILockOwner,
  type ILockState,
  type ILocksRootOptions,
} from 'jg-locks';
import { z } from 'zod';

import type { IPreviousRuntimeCheck } from '../types.js';
import { HQ_ERRORS } from '../../errors/index.js';

import {
  ACTION_KEY_FILE,
  DATABASE_FILE,
  LOCKS_DIRECTORY,
  RUNTIME_LOCK,
  SNAPSHOT_LOCK,
} from './constants.js';

/** Checks POSIX ownership and permission bits for private runtime state. */
export const isPrivateOwner = (details: Stats): boolean =>
  details.uid === process.getuid?.() && (details.mode & 0o077) === 0;

/**
 * Names the private folder of the locks HQ takes in a state root.
 * @param stateRoot The canonical state root.
 * @returns jg-locks' root option for that folder.
 */
export const toLocksRoot = (stateRoot: string): ILocksRootOptions => ({
  root: join(stateRoot, ...LOCKS_DIRECTORY),
});

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
    const key = await readPrivateFile(path, { maxBytes: 32 });
    if (key.length !== 32)
      throw HQ_ERRORS.create('actionKeyUnavailable', { data: { kind: 'state-conflict' } });
    return key;
  } catch (error) {
    if (hasErrorCode(error, FS_ERRORS.FILE_NOT_PRIVATE))
      throw HQ_ERRORS.create('stateFileUnsafe', { data: { kind: 'state-conflict' }, cause: error });
    if (hasErrorCode(error, 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE')) throw error;
    if (!hasErrorCode(error, FS_ERRORS.NON_EXISTENT_FILE))
      throw new Exception(`The HQ action key is unavailable: ${extractMessage(error)}`, {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
        cause: error,
      });
  }
  if ((await lstat(databasePath)).size !== 0)
    throw HQ_ERRORS.create('actionKeyUnavailable', { data: { kind: 'state-conflict' } });
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
 * Creates the state directory privately when missing, then canonicalizes it.
 * @returns The absolute private state directory.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 */
export const prepareStateRoot = async (stateRoot: string): Promise<string> => {
  if (!isAbsolute(stateRoot))
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  try {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const details = await lstat(stateRoot);
    if (!details.isDirectory() || !isPrivateOwner(details))
      throw HQ_ERRORS.create('stateDirectoryUnsafe', { data: { kind: 'state-conflict' } });
    return await realpath(stateRoot);
  } catch (cause) {
    if (hasErrorCode(cause, 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE')) throw cause;
    throw new Exception(`The HQ state directory is unsafe: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE',
      data: { kind: 'state-conflict' },
      cause,
    });
  }
};

/**
 * Resolves each allowed workspace once at startup, with no path-based authority from the client.
 * @returns Canonical allowed workspace roots.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const resolveAllowedRoots = async (roots: string[]): Promise<string[]> => {
  if (!roots.length || roots.length > 128 || roots.some((root) => !isAbsolute(root)))
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  const result: string[] = [];
  for (const root of roots) {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory())
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
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
    throw HQ_ERRORS.create('targetForbidden', {
      data: { kind: 'access-denied' },
    });
  const canonical = await realpath(target);
  if (!allowedRoots.some((root) => isPathWithin(root, canonical)))
    throw HQ_ERRORS.create('targetForbidden', {
      data: { kind: 'access-denied' },
    });
  return canonical;
};

/**
 * Reads the runtime lock's owner without taking it, in a state directory only this user can use.
 * @returns The owner, whose nonce is the runtime epoch, also when its process is gone.
 * @throws
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 */
export const readRuntimeOwner = async (stateRoot: string): Promise<ILockOwner> => {
  let lock: ILockState;
  try {
    const directory = await lstat(stateRoot);
    if (!directory.isDirectory() || !isPrivateOwner(directory))
      throw HQ_ERRORS.create('stateDirectoryUnsafe', {
        data: { kind: 'state-conflict' },
      });
    lock = await inspectLock(RUNTIME_LOCK, toLocksRoot(stateRoot));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      throw HQ_ERRORS.create('runtimeNotRunning', {
        data: { kind: 'agent-unavailable' },
        cause: error,
      });
    if (hasErrorCode(error, 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE')) throw error;
    throw new Exception(`The HQ runtime owner is unverifiable: ${extractMessage(error)}`, {
      code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
      data: { kind: 'state-conflict' },
      cause: error,
    });
  }
  // a lock without its owner record is being taken or released, so no runtime serves it
  if (lock.state === 'free' || lock.state === 'ownerless')
    throw HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'agent-unavailable' } });
  // the nonce binds every IPC request to the runtime's epoch, a UUID
  if (lock.owner === null || !z.uuid().safeParse(lock.owner.nonce).success)
    throw HQ_ERRORS.create('runtimeOwnerUnverifiable', { data: { kind: 'state-conflict' } });
  return lock.owner;
};

/**
 * Fails a claim whose state root another runtime owns, or may still own.
 * @throws
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 */
const alreadyOwned: (cause?: unknown) => never = (cause) => {
  throw HQ_ERRORS.create('runtimeAlreadyOwned', {
    data: { kind: 'state-conflict' },
    ...(cause === undefined ? {} : { cause }),
  });
};

/**
 * Takes the runtime lock for the runtime's lifetime. A lock whose owner's process is gone is taken
 * over from exactly that owner, with jg-locks' `recoverFrom`, only when the host's
 * `isPreviousRuntimeStopped` check resolves true; otherwise the claim fails, as it always does
 * without a check. jg-locks lets at most one caller take a given dead owner's lock over.
 * @returns The runtime's epoch, the stopped runtime it replaced, if any, and the lock's release,
 * which rejects with RUNTIME_OWNER_UNVERIFIABLE when the lock can't be released.
 * @throws
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 * - LOCK_ACQUISITION_FAILED: The lock '<path>' could not be acquired.
 * - NOT_A_DIRECTORY: The path '<path>' is not a directory.
 * - DIRECTORY_NOT_PRIVATE: The directory '<path>' can be accessed by other users.
 * - PATH_NOT_CANONICAL: The path '<path>' goes through a symbolic link.
 */
export const claimRuntimeOwner = async (
  stateRoot: string,
  isPreviousRuntimeStopped?: IPreviousRuntimeCheck,
) => {
  const locks = toLocksRoot(stateRoot);
  let lock: ILock;
  let previous: ILockOwner | null = null;
  try {
    lock = await acquireLock(RUNTIME_LOCK, locks);
  } catch (error) {
    if (!hasErrorCode(error, FS_ERRORS.LOCK_BUSY)) throw error;
    const held = await inspectLock(RUNTIME_LOCK, locks);
    // a process that exists, or an owner jg-locks can't judge, may still own the state root
    if (!isPreviousRuntimeStopped || held.state !== 'owner-gone' || !held.owner?.startedAt)
      return alreadyOwned(error);
    let isStopped: boolean;
    try {
      isStopped = await isPreviousRuntimeStopped({
        pid: held.owner.pid,
        createdAt: held.owner.startedAt,
      });
    } catch (cause) {
      return alreadyOwned(cause);
    }
    if (isStopped !== true) return alreadyOwned();
    try {
      lock = await acquireLock(RUNTIME_LOCK, { ...locks, recoverFrom: held.owner });
    } catch (cause) {
      return alreadyOwned(cause);
    }
    previous = held.owner;
  }
  return {
    epoch: lock.owner.nonce,
    // the runtime that stopped without releasing the state root, which may hold its leftovers
    previous,
    async release(): Promise<void> {
      try {
        await lock.release();
      } catch (cause) {
        throw new Exception(`The HQ runtime owner is unverifiable: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
          data: { kind: 'state-conflict' },
          cause,
        });
      }
    },
  };
};

/**
 * Takes over a snapshot lock that a stopped runtime's process left behind, once the host proved no
 * process of that runtime remains. A lock any other process holds or left stays as it is.
 * @param stateRoot The canonical state root.
 * @param pid The stopped runtime's process ID.
 * @returns A promise resolved once such a lock is released.
 * @throws
 * - LOCK_BUSY: The lock '<path>' is busy.
 * - LOCK_ACQUISITION_FAILED: The lock '<path>' could not be acquired.
 * - LOCK_NOT_OWNED: The lock '<path>' is no longer owned by this process.
 * - LOCK_RELEASE_FAILED: The lock '<path>' could not be released.
 * - NOT_A_DIRECTORY: The path '<path>' is not a directory.
 * - DIRECTORY_NOT_PRIVATE: The directory '<path>' can be accessed by other users.
 * - PATH_NOT_CANONICAL: The path '<path>' goes through a symbolic link.
 */
export const recoverSnapshotLock = async (stateRoot: string, pid: number): Promise<void> => {
  const locks = toLocksRoot(stateRoot);
  const snapshot = await inspectLock(SNAPSHOT_LOCK, locks);
  if (snapshot.state !== 'owner-gone' || snapshot.owner?.pid !== pid) return;
  const lock = await acquireLock(SNAPSHOT_LOCK, { ...locks, recoverFrom: snapshot.owner });
  await lock.release();
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
        throw HQ_ERRORS.create('stateFileUnsafe', { data: { kind: 'state-conflict' } });
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return path;
};
