import { Worker } from 'node:worker_threads';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import {
  BrowserReceiptSchema,
  ActionReceiptSchema,
  ManagedThreadSchema,
  HistoryProvenanceSchema,
  SessionStateSchema,
  SessionTransitionPageSchema,
} from '../contracts/index.js';
import { createPendingRequests } from '../pending/index.js';
import { ClaudeHistoryReadSchema } from '../providers/claude/history/index.js';
import type { IStorageDescriptor } from '../storage/index.js';
import { HQ_ERRORS } from '../errors/index.js';

import {
  AdmissionResultSchema,
  ObservationResultSchema,
  DispatchSchema,
  ManagedThreadPageSchema,
  ActionPageSchema,
  ApprovalIdentitySchema,
  ApprovalPageSchema,
  TurnRecordSchema,
} from './control/index.js';
import { ActiveSessionRecordsSchema } from './sessions/index.js';
import {
  StoreRequestSchema,
  StoreResponseSchema,
  type IStore,
  type IStoreCommand,
} from './types.js';
import { toWorkerExecArgv } from './utilities.js';

/**
 * Owns SQLite in one dedicated worker; requests and queued payloads are bounded.
 * @returns A store whose close waits for worker exit.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const createStore = async (
  databasePath: string,
  runtimeEpoch: string,
  actionKey: Uint8Array,
): Promise<IStore> => {
  const worker = new Worker(new URL('./store.worker.js', import.meta.url), {
    execArgv: toWorkerExecArgv(),
    // indexing a large transcript otherwise grows the young generation to V8's default maximum
    resourceLimits: { maxYoungGenerationSizeMb: 16 },
    workerData: { databasePath, runtimeEpoch, actionKey },
  });
  let hasExited = false;
  const exited = new Promise<void>((resolve) =>
    worker.once('exit', () => {
      hasExited = true;
      resolve();
    }),
  );
  const pending = createPendingRequests<number>();
  let sequence = 0;
  let isAvailable = true;
  let closing: Promise<void> | undefined;
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: unknown) => void = () => undefined;
  let storage: IStorageDescriptor | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = (cause: unknown): void => {
    isAvailable = false;
    const error = new Exception(`The HQ store failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORE_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
    readyReject(error);
    pending.rejectAll(error);
  };
  worker.on('message', (message: unknown) => {
    const result = StoreResponseSchema.safeParse(message);
    if (!result.success) {
      fail(result.error);
      return;
    }
    const response = result.data;
    if (response.kind === 'ready') {
      storage = response.storage;
      readyResolve();
      return;
    }
    if (response.kind === 'startup-error') {
      isAvailable = false;
      readyReject(
        new Exception(response.error.message, {
          code: response.error.code,
          data: { kind: response.error.kind },
        }),
      );
      return;
    }
    if (response.error)
      pending.reject(
        response.id,
        new Exception(response.error.message, {
          code: response.error.code,
          data: {
            kind: response.error.kind,
          },
        }),
      );
    else pending.resolve(response.id, response.result);
  });
  worker.once('error', fail);
  worker.once('exit', (code) =>
    fail(
      new Exception(`The HQ store failed: worker exited (${code})`, {
        code: 'JG_AGENT_HQ_STORE_FAILED',
      }),
    ),
  );
  const timer = setTimeout(
    () =>
      fail(
        new Exception('The HQ store failed: startup deadline exceeded', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
        }),
      ),
    5000,
  );
  try {
    await ready;
  } catch (error) {
    try {
      await worker.terminate();
      await exited;
    } catch (cleanup) {
      throw new Exception(`The HQ store failed: ${extractMessage(cleanup)}`, {
        code: 'JG_AGENT_HQ_STORE_FAILED',
        data: { kind: 'operation-failed', cleanupUnconfirmed: true },
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const request = async <T>(command: IStoreCommand, schema: z.ZodType<T>): Promise<T> => {
    // IPC, native callbacks and queue dispatch share the one worker, with bounded headroom.
    if (!isAvailable || pending.size >= 128)
      throw HQ_ERRORS.create('storeFailed', { data: { kind: 'operation-failed' } });
    const id = ++sequence;
    const parsed = StoreRequestSchema.safeParse({ id, command });
    if (!parsed.success)
      throw HQ_ERRORS.create('storeFailed', {
        data: { kind: 'operation-failed' },
        cause: parsed.error,
      });
    // a backup steps through the whole database, so it has no deadline
    const response = pending.add(
      id,
      command.kind === 'snapshot-backup' ? undefined : 5000,
      () =>
        new Exception('The HQ store failed: request deadline exceeded', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
          data: { kind: 'operation-failed' },
        }),
    );
    try {
      worker.postMessage(parsed.data);
    } catch (cause) {
      pending.reject(id, cause);
    }
    const checked = schema.safeParse(await response);
    if (!checked.success)
      throw HQ_ERRORS.create('storeFailed', {
        data: { kind: 'operation-failed' },
        cause: checked.error,
      });
    return checked.data;
  };
  return {
    storage: storage!,
    prepareStorageMaintenance: () => request({ kind: 'storage-maintenance' }, z.boolean()),
    snapshotBackup: async (destination) => {
      await request({ kind: 'snapshot-backup', destination }, z.null());
    },
    getBrowserAction: (id, operatorId) =>
      request({ kind: 'browser-read', id, operatorId }, BrowserReceiptSchema.nullable()),
    admitBrowserAction: (action, operatorId) =>
      request(
        { kind: 'browser-admit', action, operatorId },
        z.object({ receipt: BrowserReceiptSchema, isNew: z.boolean() }),
      ),
    settleBrowserAction: (id, operatorId, state) =>
      request({ kind: 'browser-settle', id, operatorId, state }, BrowserReceiptSchema.nullable()),
    get isAvailable() {
      return isAvailable;
    },
    readClaudeHistory: (command) =>
      request({ kind: 'claude-history', request: command }, ClaudeHistoryReadSchema),
    getEvidenceOrigins: (command) =>
      request(
        { kind: 'evidence-origins', request: command },
        z.array(HistoryProvenanceSchema.nullable()).max(128),
      ),
    observeSessions: async (provider, sessions, isComplete) => {
      await request({ kind: 'sessions-observe', provider, sessions, isComplete }, z.null());
    },
    markSessionsUnknown: async (provider) => {
      await request({ kind: 'sessions-unknown', provider }, z.null());
    },
    getSessionStates: (provider, nativeIds) =>
      request(
        { kind: 'sessions-states', provider, nativeIds },
        z.array(z.object({ nativeId: z.string(), state: SessionStateSchema })),
      ),
    listSessionTransitions: (afterSequence, limit) =>
      request({ kind: 'session-transitions', afterSequence, limit }, SessionTransitionPageSchema),
    listActiveSessions: (limit, includedKeys) =>
      request({ kind: 'sessions-active', limit, includedKeys }, ActiveSessionRecordsSchema),
    getClaudeTranscriptRoot: (nativeId) =>
      request({ kind: 'claude-transcript-root', nativeId }, z.string().nullable()),
    getAction: (id) => request({ kind: 'action-read', id }, ActionReceiptSchema.nullable()),
    getThread: (id) => request({ kind: 'thread-read', id }, ManagedThreadSchema.nullable()),
    suggestThreadName: (name) =>
      request({ kind: 'thread-name-suggest', name }, ManagedThreadSchema.shape.name),
    getThreadByNativeId: (provider, nativeId) =>
      request({ kind: 'native-thread-read', provider, nativeId }, ManagedThreadSchema.nullable()),
    getTurnRecord: (provider, nativeId) =>
      request({ kind: 'turn-record', provider, nativeId }, TurnRecordSchema.nullable()),
    getNativeThreads: (provider, nativeIds) =>
      request(
        { kind: 'native-threads', provider, nativeIds },
        z.array(ManagedThreadSchema).max(128),
      ),
    listThreads: (workspaceRoot, page) =>
      request({ kind: 'threads', workspaceRoot, page }, ManagedThreadPageSchema),
    getUnstartedThread: (provider, nativeId) =>
      request({ kind: 'thread-unstarted', provider, nativeId }, ManagedThreadSchema.nullable()),
    listUnstartedThreads: (provider, workspaceRoot, limit) =>
      request(
        { kind: 'threads-unstarted', provider, workspaceRoot, limit },
        z.object({ data: z.array(ManagedThreadSchema).max(128), isTruncated: z.boolean() }),
      ),
    listActions: (threadId, page) => request({ kind: 'actions', threadId, page }, ActionPageSchema),
    listApprovals: (threadId, page) =>
      request({ kind: 'approvals', threadId, page }, ApprovalPageSchema),
    admit: (input) => request({ kind: 'admit', input }, AdmissionResultSchema),
    applyOutcome: (input) => request({ kind: 'outcome', input }, ActionReceiptSchema.nullable()),
    observe: (input) => request({ kind: 'observe', input }, ObservationResultSchema),
    claimQueued: (threadId) =>
      request({ kind: 'claim-queue', threadId }, DispatchSchema.nullable()),
    openApproval: (input) =>
      request({ kind: 'approval', input }, ApprovalIdentitySchema.nullable()),
    releaseControls: async () => {
      await request({ kind: 'release' }, z.null());
    },
    listReattachable: () => request({ kind: 'reattachable' }, z.array(ManagedThreadSchema)),
    reattach: (input) => request({ kind: 'reattach', input }, ObservationResultSchema.nullable()),
    quarantineThread: async (threadId) => {
      await request({ kind: 'quarantine', threadId }, z.null());
    },
    close: (): Promise<void> =>
      (closing ??= (async () => {
        try {
          await request({ kind: 'close' }, z.null());
          await exited;
        } finally {
          if (!hasExited) await worker.terminate();
          await exited;
        }
      })()),
  };
};
