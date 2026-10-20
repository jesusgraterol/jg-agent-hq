import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { Exception, extractMessage, hasErrorCode } from 'error-message-utils';

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

/**
 * Requires the documented POSIX host contract before filesystem access.
 * @throws
 * - -1: The HQ lock requires Linux or macOS
 */
const requireSupportedHost = (): void => {
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Exception('The HQ lock requires Linux or macOS');
};

// the state root is trusted; metadata must still exclude other OS users
const isPrivateOwner = (details: Stats): boolean =>
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
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 */
const ensureRuntimeDirectory = async (root: string): Promise<string> => {
  requireSupportedHost();
  const directory = join(root, RUNTIME_DIRECTORY);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR'))
      throw new Exception(
        `The HQ runtime directory must be a real directory: ${extractMessage(error)}`,
        undefined,
        undefined,
        { cause: error },
      );
    throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Exception('The HQ runtime directory must be a real directory');
  if (!isPrivateOwner(details))
    throw new Exception('The HQ runtime directory must be private and owned by the current user');
  return directory;
};

/**
 * Reads the stored lock without modifying it.
 * @returns A promise that resolves to the bounded owner record or its missing/empty state.
 * @throws
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 * - -1: The HQ lock must be a regular file
 * - -1: The HQ lock must be private and owned by the current user
 * - -1: The HQ lock owner exceeds the supported size
 * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 */
const readStoredLock = async (path: string): Promise<IStoredLock> => {
  requireSupportedHost();
  let content: string;
  try {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Exception('The HQ runtime directory must be a real directory');
    if (!isPrivateOwner(directory))
      throw new Exception('The HQ runtime directory must be private and owned by the current user');
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Exception('The HQ lock must be a regular file');
      if (!isPrivateOwner(details))
        throw new Exception('The HQ lock must be private and owned by the current user');
      const buffer = Buffer.alloc(MAX_LOCK_OWNER_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_LOCK_OWNER_BYTES)
        throw new Exception('The HQ lock owner exceeds the supported size');
      content = buffer.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    if (hasErrorCode(error, 'ELOOP'))
      throw new Exception('The HQ lock must be a regular file', undefined, undefined, {
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
      undefined,
      undefined,
      { cause: error },
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
 * - -1: The HQ lock acquisition arguments are invalid
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 * - -1: The HQ lock must be a regular file
 * - -1: The HQ lock must be private and owned by the current user
 * - -1: The HQ lock owner exceeds the supported size
 * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - -1: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - -1: The HQ lock has an inactive owner
 * - -1: The HQ lock owner could not be verified
 * - -1: Timed out waiting for the HQ lock
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
    throw new Exception('The HQ lock acquisition arguments are invalid', undefined, undefined, {
      cause: input.error,
    });
  const path = join(await ensureRuntimeDirectory(root), HQ_LOCK_FILE);
  const owner: IHqLockOwner = {
    pid: process.pid,
    nonce: randomUUID(),
    command: input.data.command,
    createdAt: new Date().toISOString(),
  };
  const content = `${JSON.stringify(owner)}\n`;
  if (Buffer.byteLength(content) > MAX_LOCK_OWNER_BYTES)
    throw new Exception('The HQ lock owner exceeds the supported size');
  const startedAt = Date.now();
  let emptySince: number | undefined;
  let hasReportedWait = false;
  while (true) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      const stored = await readStoredLock(path);
      if (stored.kind === 'missing') continue;
      if (stored.kind === 'empty') {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= setupWindowMs)
          throw new Exception(
            `The HQ lock owner is incomplete. Inspect ${RUNTIME_DIRECTORY}/${HQ_LOCK_FILE} and remove it only after its owner stopped`,
          );
        await wait(pollIntervalMs);
        continue;
      }
      emptySince = undefined;
      const holder = describeOwner(stored.owner);
      const liveness = getOwnerLiveness(stored.owner.pid);
      if (liveness === 'dead') throw new Exception(`The HQ lock has an inactive owner: ${holder}`);
      if (liveness === 'unknown')
        throw new Exception(`The HQ lock owner could not be verified: ${holder}`);
      if (Date.now() - startedAt >= waitTimeoutMs)
        throw new Exception(`Timed out waiting for the HQ lock: ${holder}`);
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
          throw new Exception('HQ lock ownership changed before release');
        await rm(path);
      })());
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
 * - -1: The HQ lock acquisition arguments are invalid
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 * - -1: The HQ lock must be a regular file
 * - -1: The HQ lock must be private and owned by the current user
 * - -1: The HQ lock owner exceeds the supported size
 * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - -1: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - -1: The HQ lock has an inactive owner
 * - -1: The HQ lock owner could not be verified
 * - -1: Timed out waiting for the HQ lock
 * - -1: HQ lock ownership changed before release
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
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 * - -1: The HQ lock must be a regular file
 * - -1: The HQ lock must be private and owned by the current user
 * - -1: The HQ lock owner exceeds the supported size
 * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - -1: The HQ lock is not held
 * - -1: The HQ lock nonce does not match
 */
export const releaseHqLock = async (root: string, nonce: string): Promise<IHqLockOwner> => {
  const path = join(root, RUNTIME_DIRECTORY, HQ_LOCK_FILE);
  const stored = await readStoredLock(path);
  if (stored.kind === 'missing') throw new Exception('The HQ lock is not held');
  if (stored.kind === 'empty')
    throw new Exception(
      `The HQ lock owner could not be read. Inspect ${RUNTIME_DIRECTORY}/${HQ_LOCK_FILE}: empty file`,
    );
  const holder = describeOwner(stored.owner);
  if (stored.owner.nonce !== nonce)
    throw new Exception(`The HQ lock nonce does not match: ${holder}`);
  // remove only while the file still holds the inspected owner
  const current = await readStoredLock(path);
  if (current.kind !== 'owner' || current.content !== stored.content)
    throw new Exception(`The HQ lock nonce does not match: ${holder}`);
  await rm(path);
  return stored.owner;
};

/**
 * Reports the HQ lock for status output without acquiring or changing it.
 * @param root The trusted state root.
 * @param now The current time.
 * @returns A promise that resolves to the lock state.
 * @throws
 * - -1: The HQ lock requires Linux or macOS
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
