import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';
import { ERRORS as FS_ERRORS } from 'jg-fs';
import { withLock } from 'jg-locks';
import { z } from 'zod';

import type { IAgentHq } from '../runtime/index.js';
import { SNAPSHOT_LOCK, toLocksRoot } from '../runtime/state/index.js';
import { toWorkerExecArgv } from '../store/index.js';
import { HQ_ERRORS } from '../errors/index.js';

import { captureSnapshot } from './capture.js';
import { invalidSnapshot, syncSnapshotDirectory } from './files.js';
import {
  RestoreOptionsSchema,
  SnapshotWorkerResponseSchema,
  type IHqSnapshotInspection,
  type IHqRestoreOptions,
  type IHqRestoreResult,
  type ISnapshotContext,
} from './types.js';

const contexts = new WeakMap<IAgentHq, ISnapshotContext>();

/** Binds trusted Node runtime state without adding worker handles or backup commands to RPC. */
export const registerSnapshotContext = (context: ISnapshotContext): void => {
  contexts.set(context.runtime, context);
};

/**
 * Runs full SQLite verification/restoration off the caller's event loop and confirms worker exit.
 * @returns The validated snapshot metadata.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
const runSnapshotWorker = async (input: {
  kind: 'inspect' | 'restore';
  directory: string;
  destination?: string;
}): Promise<IHqSnapshotInspection> => {
  const worker = new Worker(new URL('./snapshots.worker.js', import.meta.url), {
    execArgv: toWorkerExecArgv(),
    workerData: input,
  });
  return new Promise((resolveResult, rejectResult) => {
    let response: ReturnType<typeof SnapshotWorkerResponseSchema.parse> | undefined;
    let failure: unknown;
    let hasDuplicateResponse = false;
    worker.on('message', (message: unknown) => {
      const parsed = SnapshotWorkerResponseSchema.safeParse(message);
      if (response) hasDuplicateResponse = true;
      else if (!parsed.success) failure = parsed.error;
      else response = parsed.data;
    });
    worker.once('error', (cause) => {
      failure = cause;
    });
    worker.once('exit', (code) => {
      if (failure || hasDuplicateResponse || code !== 0 || !response)
        rejectResult(
          new Exception(
            `The HQ snapshot operation failed: ${failure ? extractMessage(failure) : hasDuplicateResponse ? 'Duplicate snapshot worker result' : `Worker exited (${code})`}`,
            {
              code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
              data: { kind: 'operation-failed' },
              cause: failure,
            },
          ),
        );
      else if (response.kind === 'error')
        rejectResult(
          new Exception(response.message, {
            code: response.code,
            data: {
              kind:
                response.code === 'JG_AGENT_HQ_SNAPSHOT_INVALID'
                  ? 'invalid-request'
                  : response.code === 'JG_AGENT_HQ_STORAGE_INVALID'
                    ? 'state-conflict'
                    : 'operation-failed',
            },
          }),
        );
      else resolveResult(response.result);
    });
  });
};

// how long capture waits for another holder of the snapshot lock, in seconds
const SNAPSHOT_LOCK_WAIT_SECONDS = 120;

/**
 * Captures a running HQ, host tables and private key while agents keep working, under the state
 * root's snapshot lock. The host must keep its own connections from writing host tables until the
 * capture resolves. The destination must be absent under an existing canonical parent.
 * @returns A fully verified local snapshot; remote durability remains the host's responsibility.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const createHqSnapshot = async (
  runtime: IAgentHq,
  destination: string,
): Promise<IHqSnapshotInspection> => {
  const context = contexts.get(runtime);
  if (
    !context ||
    context.isClosing() ||
    typeof destination !== 'string' ||
    !isAbsolute(destination) ||
    resolve(destination) !== destination
  )
    invalidSnapshot();
  let owned: string | undefined;
  try {
    return await context.admit(() =>
      withLock(
        SNAPSHOT_LOCK,
        { ...toLocksRoot(context.stateRoot), waitSeconds: SNAPSHOT_LOCK_WAIT_SECONDS },
        async () => {
          const result = await captureSnapshot(
            {
              stateRoot: context.stateRoot,
              allowedRoots: context.allowedRoots,
              actionKeyHash: context.actionKeyHash,
              schemaHash: context.store.storage.schemaHash,
              backupDatabase: (path) => context.store.snapshotBackup(path),
              verify: inspectHqSnapshot,
            },
            destination,
          );
          owned = result.directory;
          return result;
        },
      ),
    );
  } catch (cause) {
    if (owned) {
      try {
        await rm(owned, { recursive: true });
        await syncSnapshotDirectory(dirname(owned));
      } catch (cleanup) {
        cause = new AggregateError([cause, cleanup], 'Snapshot cleanup failed');
      }
    }
    if (
      hasErrorCode(cause, 'JG_AGENT_HQ_ACTION_CONFLICT') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_INVALID') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_FAILED') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_STORAGE_INVALID')
    )
      throw cause;
    // a live holder that kept the lock through the whole wait, unlike a dead one, conflicts
    if (
      isException(cause) &&
      cause.code === FS_ERRORS.LOCK_BUSY &&
      z.object({ reason: z.literal('held') }).safeParse(cause.data).success
    )
      throw HQ_ERRORS.create('actionConflict', { data: { kind: 'state-conflict' }, cause });
    throw new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};

/**
 * Validates private files, manifest hashes, supported schema and SQLite integrity.
 * @returns The snapshot's directory, manifest hash and header.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
export const inspectHqSnapshot = async (directory: string): Promise<IHqSnapshotInspection> => {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory)
    invalidSnapshot();
  return runSnapshotWorker({ kind: 'inspect', directory });
};

/**
 * Restores offline into a new, private recovery workspace without replacing a repository or state root.
 * All runtime/host connections to any proposed destination must be stopped. Stored roots are evidence;
 * createAgentHq requires the host's explicit allowedRoots and a fresh native ownership decision.
 * @returns The new state root, with source snapshot metadata.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
export const restoreHqSnapshot = async (options: IHqRestoreOptions): Promise<IHqRestoreResult> => {
  const parsed = RestoreOptionsSchema.safeParse(options);
  if (!parsed.success) invalidSnapshot();
  const { snapshotDirectory: directory, destination } = parsed.data;
  const inspection = await runSnapshotWorker({ kind: 'restore', directory, destination });
  return { ...inspection, stateRoot: join(destination, 'state') };
};
