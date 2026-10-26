import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Exception, extractMessage, hasErrorCode } from 'jg-exception';

import type { IAgentHq } from '../runtime/index.js';
import { acquireHqLock } from '../locks/index.js';

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
    execArgv: process.execArgv.filter(
      (argument, index, args) =>
        argument !== '--input-type' &&
        !argument.startsWith('--input-type=') &&
        args[index - 1] !== '--input-type',
    ),
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

/**
 * Captures a running HQ, host tables, private key and registered plan companions while agents
 * keep working. HQ-mediated plan writes wait for the coordination metadata lock; the host must
 * keep its own connections from writing host tables until the capture resolves.
 * The destination must be absent under an existing canonical parent.
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
    return await context.admit(async () => {
      let release: (() => Promise<void>) | undefined;
      let failure: unknown;
      try {
        release = await acquireHqLock(context.coordinationRoot, 'snapshot');
        const result = await captureSnapshot(
          {
            stateRoot: context.stateRoot,
            coordinationRoot: context.coordinationRoot,
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
      } catch (cause) {
        failure = cause;
        throw cause;
      } finally {
        try {
          await release?.();
        } catch (cleanup) {
          if (failure)
            throw new AggregateError([failure, cleanup], 'Snapshot metadata lock release failed');
          throw cleanup;
        }
      }
    });
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
    if (
      hasErrorCode(cause, 'JG_PLANS_LOCK_BUSY') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_LOCK_TIMEOUT')
    )
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: { kind: 'state-conflict' },
        cause,
      });
    throw new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};

/**
 * Validates private files, manifest hashes, supported schema, SQLite integrity and exact report payloads.
 * @returns Bounded metadata; recovery.jsonl retains the streamed plan mapping after restore.
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
 * @returns The new state root and separate plan recovery directory, with source snapshot metadata.
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
  return {
    ...inspection,
    stateRoot: join(destination, 'state'),
    recoveryRoot: join(destination, 'plans'),
  };
};
