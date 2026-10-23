import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, hasErrorCode } from 'jg-exception';
import { writePrivateFile } from 'jg-fs';
import { withPlanDocumentLocks } from 'jg-plans';

import type { IAgentHq } from '../runtime/index.js';
import { isWithinWorkspace } from '../runtime/state/index.js';
import { acquireHqLock } from '../locks/index.js';

import { observeSnapshotPlan } from './artifacts.js';
import {
  SNAPSHOT_COMPLETE,
  SNAPSHOT_COMPANIONS,
  SNAPSHOT_LINE_BYTES,
  SNAPSHOT_MANIFEST,
} from './constants.js';
import {
  copySnapshotFile,
  invalidSnapshot,
  reserveSnapshotDirectory,
  syncSnapshotDirectory,
} from './files.js';
import {
  RestoreOptionsSchema,
  SnapshotHeaderSchema,
  SnapshotRecordSchema,
  SnapshotWorkerResponseSchema,
  type IHqSnapshotInspection,
  type IHqRestoreOptions,
  type IHqRestoreResult,
  type ISnapshotContext,
  type ISnapshotPlan,
  type ISnapshotRecord,
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
                  : 'operation-failed',
            },
          }),
        );
      else resolveResult(response.result);
    });
  });
};

/**
 * Copies one plan under its shared document locks; corrupt or missing source evidence stays explicit.
 * @returns One fixed-size inventory record, with no repaired or invented authority.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
const capturePlan = async (
  context: ISnapshotContext,
  directory: string,
  snapshot: string,
): Promise<ISnapshotPlan> => {
  const record: ISnapshotPlan = {
    kind: 'plan',
    key: hashValue(directory),
    sourceDirectory: directory,
    planId: null,
    revision: null,
    plan: null,
    milestones: null,
    coordination: null,
    diagnostics: [],
  };
  if (!context.allowedRoots.some((root) => isWithinWorkspace(root, directory))) {
    record.diagnostics.push('plan-unavailable');
    return record;
  }
  let exists = true;
  try {
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      invalidSnapshot();
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) exists = false;
    else throw cause;
  }
  const output = join(snapshot, 'plans', record.key);
  await mkdir(output, { mode: 0o700 });
  if (exists)
    await withPlanDocumentLocks(directory, ['plan', 'milestones'], async () => {
      for (const [field, filename, maximumBytes] of SNAPSHOT_COMPANIONS)
        record[field] = await copySnapshotFile(
          join(directory, filename),
          join(output, filename),
          maximumBytes,
          false,
          true,
        );
    });
  Object.assign(record, await observeSnapshotPlan(output, record));
  await syncSnapshotDirectory(output);
  return record;
};

/**
 * Captures a quiescent running HQ, host tables, private key and registered plan companions.
 * The host must pause all of its writers. Busy checkpoints never interrupt native work.
 * The destination must be absent under an existing canonical parent.
 * @returns A fully verified local snapshot; remote durability remains the host's responsibility.
 * @throws
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
    await context.maintenance(async (storage) => {
      let release: (() => Promise<void>) | undefined;
      let failure: unknown;
      try {
        release = await acquireHqLock(context.coordinationRoot, 'snapshot', { waitTimeoutMs: 0 });
        owned = await reserveSnapshotDirectory(destination);
        await mkdir(join(owned, 'plans'), { mode: 0o700 });
        const manifest = await open(join(owned, SNAPSHOT_MANIFEST), 'wx', 0o600);
        const hash = createHash('sha256');
        let records = 0;
        const append = async (record: ISnapshotRecord) => {
          const bytes = Buffer.from(JSON.stringify(SnapshotRecordSchema.parse(record)) + '\n');
          if (bytes.length > SNAPSHOT_LINE_BYTES) invalidSnapshot();
          await manifest.writeFile(bytes);
          hash.update(bytes);
          records++;
        };
        try {
          await append(
            SnapshotHeaderSchema.parse({
              kind: 'header',
              format: 1,
              createdAt: new Date().toISOString(),
              schemaHash: storage.schemaHash,
              sourceStateRoot: context.stateRoot,
              sourceCoordinationRoot: context.coordinationRoot,
              sourceAllowedRoots: context.allowedRoots,
            }),
          );
          const database = await open(join(owned, 'hq.sqlite'), 'wx', 0o600);
          await database.close();
          await context.store.snapshotBackup(join(owned, 'hq.sqlite'));
          const capturedDatabase = await copySnapshotFile(join(owned, 'hq.sqlite'), null);
          if (!capturedDatabase) invalidSnapshot();
          await append({ kind: 'database', file: capturedDatabase });
          const key = await copySnapshotFile(
            join(context.stateRoot, 'action.key'),
            join(owned, 'action.key'),
            32,
          );
          if (key?.bytes !== 32 || key.sha256 !== context.actionKeyHash) invalidSnapshot();
          await append({ kind: 'action-key', file: key });
          let after = '';
          for (;;) {
            const page = await context.store.snapshotPlans(after);
            for (const directory of page) {
              await append(await capturePlan(context, directory, owned));
              after = directory;
            }
            if (page.length < 128) break;
          }
          await manifest.sync();
          await syncSnapshotDirectory(join(owned, 'plans'));
          await writePrivateFile(
            join(owned, SNAPSHOT_COMPLETE),
            JSON.stringify({ manifestSha256: hash.digest('hex'), records }) + '\n',
            { rootPath: owned, isExclusive: true },
          );
          await syncSnapshotDirectory(owned);
          await syncSnapshotDirectory(dirname(owned));
        } finally {
          await manifest.close();
        }
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
    }, true);
    return await inspectHqSnapshot(owned!);
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
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_FAILED')
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
 * Validates private files, manifest hashes, current schema, SQLite integrity and exact report payloads.
 * @returns Bounded metadata; recovery.jsonl retains the streamed plan mapping after restore.
 * @throws
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
