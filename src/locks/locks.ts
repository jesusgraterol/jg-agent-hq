import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { Exception, extractMessage, hasErrorCode } from 'jg-exception';

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SETUP_WINDOW_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  HQ_LOCK_FILE,
  MAX_LOCK_OWNER_BYTES,
  RUNTIME_DIRECTORY,
} from './constants.js';
import {
  HqLockAcquisitionSchema,
  HqLockOwnerSchema,
  type IHqLockOptions,
  type IHqLockOwner,
  type IHqLockState,
  type IOwnerLiveness,
} from './types.js';

// what is currently stored at the lock path
type IStoredLock =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'owner'; owner: IHqLockOwner; content: string };

// Active acquisitions only; release or failure removes each waiter and empty root.
const localWaiters = new Map<string, Set<symbol>>();

/**
 * Requires the documented POSIX host contract before filesystem access.
 * @throws
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 */
const requireSupportedHost = (): void => {
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Exception('The HQ lock requires Linux or macOS', {
      code: 'JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM',
    });
};

/** Checks POSIX ownership and permission bits for private runtime metadata. */
export const isPrivateOwner = (details: Stats): boolean =>
  details.uid === process.getuid?.() && (details.mode & 0o077) === 0;

const describeOwner = ({ pid, command, nonce, createdAt }: IHqLockOwner): string =>
  `PID ${pid}, command ${command}, nonce ${nonce}, since ${createdAt}`;

/**
 * Checks whether a lock owner's process exists without affecting it.
 * @param pid The owner process id.
 * @returns `alive`, `dead`, or `unknown` when the process exists but cannot be signaled.
 */
export const getOwnerLiveness = (pid: number): IOwnerLiveness => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return hasErrorCode(error, 'ESRCH') ? 'dead' : 'unknown';
  }
};

/**
 * Creates the private runtime directory when missing and rejects anything but a real directory.
 * @returns A promise that resolves to the verified runtime directory.
 * @throws
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 */
export const ensurePrivateRuntimeDirectory = async (directory: string): Promise<string> => {
  requireSupportedHost();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR'))
      throw new Exception(
        `The HQ runtime directory must be a real directory: ${extractMessage(error)}`,
        { code: 'JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID', cause: error },
      );
    throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Exception('The HQ runtime directory must be a real directory', {
      code: 'JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID',
    });
  if (!isPrivateOwner(details))
    throw new Exception('The HQ runtime directory must be private and owned by the current user', {
      code: 'JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS',
    });
  return directory;
};

/**
 * Reads the stored lock without modifying it.
 * @returns A promise that resolves to the bounded owner record or its missing/empty state.
 * @throws
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 */
const readStoredLock = async (path: string): Promise<IStoredLock> => {
  requireSupportedHost();
  let content: string;
  try {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Exception('The HQ runtime directory must be a real directory', {
        code: 'JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID',
      });
    if (!isPrivateOwner(directory))
      throw new Exception(
        'The HQ runtime directory must be private and owned by the current user',
        { code: 'JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS' },
      );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const details = await handle.stat();
      if (!details.isFile())
        throw new Exception('The HQ lock must be a regular file', {
          code: 'JG_AGENT_HQ_LOCK_FILE_INVALID',
        });
      if (!isPrivateOwner(details))
        throw new Exception('The HQ lock must be private and owned by the current user', {
          code: 'JG_AGENT_HQ_LOCK_FILE_PERMISSIONS',
        });
      const buffer = Buffer.alloc(MAX_LOCK_OWNER_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_LOCK_OWNER_BYTES)
        throw new Exception('The HQ lock owner exceeds the supported size', {
          code: 'JG_AGENT_HQ_LOCK_OWNER_OVERSIZED',
        });
      content = buffer.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    if (hasErrorCode(error, 'ELOOP'))
      throw new Exception('The HQ lock must be a regular file', {
        code: 'JG_AGENT_HQ_LOCK_FILE_INVALID',
        cause: error,
      });
    throw error;
  }
  if (content === '') return { kind: 'empty' };
  try {
    return { kind: 'owner', owner: HqLockOwnerSchema.parse(JSON.parse(content)), content };
  } catch (error) {
    throw new Exception(
      `The HQ lock owner could not be read. Inspect ${RUNTIME_DIRECTORY}/${HQ_LOCK_FILE}: ${extractMessage(error)}`,
      { code: 'JG_AGENT_HQ_LOCK_OWNER_UNREADABLE', cause: error },
    );
  }
};

/**
 * Acquires the HQ metadata lock. A live owner is
 * awaited; a dead or uncertain owner is never reclaimed, because its git or hook child processes
 * may still be running. The operator recovers with releaseHqLock only after inspecting the owner and its children.
 * @param root The trusted state root.
 * @param command A non-empty, single-line operation label.
 * @param options Timing overrides.
 * @returns A promise that resolves to an exact-owner release operation, which can reject with the
 * ownership-changed contract or the metadata-read contracts below.
 * @throws
 * - JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS: The HQ lock acquisition arguments are invalid
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
 * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
 * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
 */
export const acquireHqLock = async (
  root: string,
  command: string,
  {
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    setupWindowMs = DEFAULT_SETUP_WINDOW_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  }: IHqLockOptions = {},
): Promise<() => Promise<void>> => {
  const input = HqLockAcquisitionSchema.safeParse({
    command,
    waitTimeoutMs,
    setupWindowMs,
    pollIntervalMs,
  });
  if (!input.success)
    throw new Exception('The HQ lock acquisition arguments are invalid', {
      code: 'JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS',
      cause: input.error,
    });
  const path = join(
    await ensurePrivateRuntimeDirectory(join(root, RUNTIME_DIRECTORY)),
    HQ_LOCK_FILE,
  );
  const owner: IHqLockOwner = {
    pid: process.pid,
    nonce: randomUUID(),
    command: input.data.command,
    createdAt: new Date().toISOString(),
  };
  const content = `${JSON.stringify(owner)}\n`;
  if (Buffer.byteLength(content) > MAX_LOCK_OWNER_BYTES)
    throw new Exception('The HQ lock owner exceeds the supported size', {
      code: 'JG_AGENT_HQ_LOCK_OWNER_OVERSIZED',
    });
  const queueKey = resolve(path);
  const queue = localWaiters.get(queueKey) ?? new Set<symbol>();
  localWaiters.set(queueKey, queue);
  const waiter = Symbol();
  queue.add(waiter);
  const leaveQueue = (): void => {
    queue.delete(waiter);
    if (!queue.size) localWaiters.delete(queueKey);
  };
  const startedAt = Date.now();
  let emptySince: number | undefined;
  let hasReportedWait = false;
  try {
    while (true) {
      let handle;
      const hasPriority = queue.values().next().value === waiter;
      if (hasPriority) {
        try {
          handle = await open(path, 'wx', 0o600);
        } catch (error) {
          if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
      }
      if (!handle) {
        const stored = await readStoredLock(path);
        if (stored.kind === 'missing') {
          if (!hasPriority) {
            if (Date.now() - startedAt >= waitTimeoutMs)
              throw new Exception('Timed out waiting for the HQ lock', {
                code: 'JG_AGENT_HQ_LOCK_TIMEOUT',
              });
            await wait(pollIntervalMs);
          }
          continue;
        }
        if (stored.kind === 'empty') {
          emptySince ??= Date.now();
          if (Date.now() - emptySince >= setupWindowMs)
            throw new Exception(
              `The HQ lock owner is incomplete. Inspect ${RUNTIME_DIRECTORY}/${HQ_LOCK_FILE} and remove it only after its owner stopped`,
              { code: 'JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE' },
            );
          await wait(pollIntervalMs);
          continue;
        }
        emptySince = undefined;
        const holder = describeOwner(stored.owner);
        const liveness = getOwnerLiveness(stored.owner.pid);
        if (liveness === 'dead')
          throw new Exception(`The HQ lock has an inactive owner: ${holder}`, {
            code: 'JG_AGENT_HQ_LOCK_OWNER_INACTIVE',
          });
        if (liveness === 'unknown')
          throw new Exception(`The HQ lock owner could not be verified: ${holder}`, {
            code: 'JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE',
          });
        if (Date.now() - startedAt >= waitTimeoutMs)
          throw new Exception(`Timed out waiting for the HQ lock: ${holder}`, {
            code: 'JG_AGENT_HQ_LOCK_TIMEOUT',
          });
        if (!hasReportedWait) {
          process.stderr.write(`Waiting for the HQ lock (${holder}).\n`);
          hasReportedWait = true;
        }
        await wait(pollIntervalMs);
        continue;
      }
      try {
        await handle.writeFile(content);
      } finally {
        // a failed write leaves an uncertain lock in place rather than deleting it
        await handle.close();
      }
      let release: Promise<void> | undefined;
      return () =>
        (release ??= (async () => {
          const stored = await readStoredLock(path);
          if (stored.kind !== 'owner' || stored.content !== content)
            throw new Exception('HQ lock ownership changed before release', {
              code: 'JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED',
            });
          await rm(path);
        })());
    }
  } finally {
    leaveQueue();
  }
};

/**
 * Runs an operation while holding the HQ lock and releases it afterwards, also on failure.
 * @param root The trusted state root.
 * @param command A non-empty, single-line operation label.
 * @param operation The work that writes shared agent-hq state.
 * @param options Timing overrides.
 * @returns A promise that resolves to the operation's result.
 * @throws
 * - JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS: The HQ lock acquisition arguments are invalid
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
 * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
 * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
 * - JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED: HQ lock ownership changed before release
 */
export const withHqLock = async <T>(
  root: string,
  command: string,
  operation: () => Promise<T>,
  options?: IHqLockOptions,
): Promise<T> => {
  const release = await acquireHqLock(root, command, options);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    // the operation's error stays primary; a release failure is still reported
    await release().catch((releaseError: unknown) =>
      process.stderr.write(`${extractMessage(releaseError)}\n`),
    );
    throw error;
  }
  await release();
  return result;
};

/**
 * Developer recovery: removes the HQ lock without acquiring it, only while it still holds the
 * nonce the developer inspected. The developer confirms beforehand that the owner and its child
 * processes stopped; liveness is not rechecked because a reused PID would block recovery forever.
 * @param root The trusted state root.
 * @param nonce The nonce read from the inspected lock state.
 * @returns A promise that resolves to the removed owner.
 * @throws
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - JG_AGENT_HQ_LOCK_NOT_HELD: The HQ lock is not held
 * - JG_AGENT_HQ_LOCK_NONCE_MISMATCH: The HQ lock nonce does not match
 */
export const releaseHqLock = async (root: string, nonce: string): Promise<IHqLockOwner> => {
  const path = join(root, RUNTIME_DIRECTORY, HQ_LOCK_FILE);
  const stored = await readStoredLock(path);
  if (stored.kind === 'missing')
    throw new Exception('The HQ lock is not held', { code: 'JG_AGENT_HQ_LOCK_NOT_HELD' });
  if (stored.kind === 'empty')
    throw new Exception(
      `The HQ lock owner could not be read. Inspect ${RUNTIME_DIRECTORY}/${HQ_LOCK_FILE}: empty file`,
      { code: 'JG_AGENT_HQ_LOCK_OWNER_UNREADABLE' },
    );
  const holder = describeOwner(stored.owner);
  if (stored.owner.nonce !== nonce)
    throw new Exception(`The HQ lock nonce does not match: ${holder}`, {
      code: 'JG_AGENT_HQ_LOCK_NONCE_MISMATCH',
    });
  // remove only while the file still holds the inspected owner
  const current = await readStoredLock(path);
  if (current.kind !== 'owner' || current.content !== stored.content)
    throw new Exception(`The HQ lock nonce does not match: ${holder}`, {
      code: 'JG_AGENT_HQ_LOCK_NONCE_MISMATCH',
    });
  await rm(path);
  return stored.owner;
};

/**
 * Reports the HQ lock for status output without acquiring or changing it.
 * @param root The trusted state root.
 * @param now The current time.
 * @returns A promise that resolves to the lock state.
 * @throws
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 */
export const readHqLockState = async (root: string, now = new Date()): Promise<IHqLockState> => {
  requireSupportedHost();
  const path = join(root, RUNTIME_DIRECTORY, HQ_LOCK_FILE);
  try {
    const stored = await readStoredLock(path);
    if (stored.kind === 'missing') return { kind: 'free' };
    if (stored.kind === 'owner')
      return {
        kind: 'held',
        owner: stored.owner,
        liveness: getOwnerLiveness(stored.owner.pid),
        ageMs: now.getTime() - Date.parse(stored.owner.createdAt),
      };
  } catch {
    // an unreadable lock is reported as such below; status never fails because of it
  }
  try {
    const directory = await lstat(join(root, RUNTIME_DIRECTORY));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !isPrivateOwner(directory))
      return { kind: 'unreadable', ageMs: now.getTime() - directory.mtimeMs };
    return { kind: 'unreadable', ageMs: now.getTime() - (await lstat(path)).mtimeMs };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'free' };
    throw error;
  }
};
