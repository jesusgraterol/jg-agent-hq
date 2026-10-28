import { Worker } from 'node:worker_threads';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import { AgentIdentitySchema, AgentSpawnRecordSchema } from '../collaboration/identity/index.js';

import { CollaborationResponseSchema } from '../contracts/collaboration/index.js';
import { DispatchCollectionSchema } from '../contracts/collaboration/index.js';
import { DispatchPageSchema, DispatchJobSchema } from '../collaboration/dispatch/index.js';

import {
  BrowserReceiptSchema,
  ActionReceiptSchema,
  ActionPlanContextSchema,
  ManagedThreadSchema,
  type IThreadSummary,
  HistoryProvenanceSchema,
  SessionStateSchema,
  SessionTransitionPageSchema,
} from '../contracts/index.js';
import { ClaudeHistoryReadSchema } from '../providers/claude/history/index.js';
import type { IStorageDescriptor } from '../storage/index.js';

import { PlanWriteIntentSchema, PlanProjectionResultSchema } from '../plans/index.js';

import {
  AdmissionResultSchema,
  ObservationResultSchema,
  DispatchSchema,
  ManagedThreadPageSchema,
  ActionPageSchema,
  LifecyclePageSchema,
  ApprovalIdentitySchema,
  ApprovalPageSchema,
} from './control/index.js';
import { ActiveSessionRecordsSchema } from './sessions/index.js';
import {
  StoreRequestSchema,
  StoreResponseSchema,
  type IStore,
  type IStoreCommand,
} from './types.js';

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
    // the worker loads a file, even when its caller used Node's string-input mode
    execArgv: process.execArgv.filter(
      (argument, index, arguments_) =>
        argument !== '--input-type' &&
        !argument.startsWith('--input-type=') &&
        arguments_[index - 1] !== '--input-type',
    ),
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
  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
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
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
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
    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(response.id);
    if (response.error)
      entry.reject(
        new Exception(response.error.message, {
          code: response.error.code,
          data: {
            kind: response.error.kind,
          },
        }),
      );
    else entry.resolve(response.result);
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

  const request = <T>(command: IStoreCommand, schema: z.ZodType<T>): Promise<T> => {
    // IPC, native callbacks and queue dispatch share the one worker, with bounded headroom.
    if (!isAvailable || pending.size >= 128)
      return Promise.reject(
        new Exception('The HQ store failed', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
          data: { kind: 'operation-failed' },
        }),
      );
    const id = ++sequence;
    const parsed = StoreRequestSchema.safeParse({ id, command });
    if (!parsed.success)
      return Promise.reject(
        new Exception('The HQ store failed', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
          data: { kind: 'operation-failed' },
          cause: parsed.error,
        }),
      );
    return new Promise((resolve, reject) => {
      const timer =
        command.kind === 'snapshot-backup'
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              reject(
                new Exception('The HQ store failed: request deadline exceeded', {
                  code: 'JG_AGENT_HQ_STORE_FAILED',
                  data: {
                    kind: 'operation-failed',
                  },
                }),
              );
            }, 5000);
      pending.set(id, {
        resolve: (result) => {
          const checked = schema.safeParse(result);
          if (checked.success) resolve(checked.data);
          else
            reject(
              new Exception('The HQ store failed', {
                code: 'JG_AGENT_HQ_STORE_FAILED',
                data: { kind: 'operation-failed' },
                cause: checked.error,
              }),
            );
        },
        reject,
        timer,
      });
      worker.postMessage(parsed.data);
    });
  };
  return {
    storage: storage!,
    dispatchPage: (query) => request({ kind: 'dispatch-page', query }, DispatchPageSchema),
    dispatchJob: (taskId, requestId) =>
      request({ kind: 'dispatch-job', taskId, requestId }, DispatchJobSchema),
    blockDispatch: async (requestId, selectedActionId, reason) => {
      await request({ kind: 'dispatch-block', requestId, selectedActionId, reason }, z.null());
    },
    collectDispatch: (taskId, requestId, actionId) =>
      request(
        { kind: 'dispatch-collect', taskId, requestId, actionId },
        DispatchCollectionSchema.nullable(),
      ),
    agentIdentity: (query) => request({ kind: 'agent-identity', query }, AgentIdentitySchema),
    getAgentSpawn: (query) =>
      request({ kind: 'agent-spawn-read', query }, AgentSpawnRecordSchema.nullable()),
    collaboration: (command, binding) =>
      request({ kind: 'collaboration', request: command, binding }, CollaborationResponseSchema),
    recoverCollaborationFanout: () => request({ kind: 'collaboration-fanout' }, z.boolean()),
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
    registerPlan: async (directory) => {
      await request({ kind: 'plan-register', directory }, z.null());
    },
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
    listActiveSessions: (limit) =>
      request({ kind: 'sessions-active', limit }, ActiveSessionRecordsSchema),
    getThreadPlan: (threadId) =>
      request({ kind: 'thread-plan-read', threadId }, ActionPlanContextSchema.nullable()),
    getPlanThreads: (directory) =>
      request({ kind: 'plan-threads', directory }, z.array(z.uuid()).max(32)),
    peekQueued: (threadId) =>
      request({ kind: 'queue-peek', threadId }, ActionReceiptSchema.nullable()),
    getPlanOperation: (id) =>
      request({ kind: 'plan-operation', id }, PlanWriteIntentSchema.nullable()),
    getPendingPlanOperationId: (directory) =>
      request({ kind: 'plan-pending', directory }, z.uuid().nullable()),
    preparePlanOperation: (intent) =>
      request({ kind: 'plan-prepare', intent }, PlanWriteIntentSchema),
    completePlanOperation: async (id) => {
      try {
        await request({ kind: 'plan-complete', id }, z.null());
      } catch (cause) {
        let recorded;
        try {
          recorded = await request(
            { kind: 'plan-operation', id },
            PlanWriteIntentSchema.nullable(),
          );
        } catch (observation) {
          throw new Exception('The HQ store failed: plan completion could not be confirmed', {
            code: 'JG_AGENT_HQ_STORE_FAILED',
            data: { kind: 'operation-failed' },
            cause: new AggregateError([cause, observation], 'Plan ledger completion is uncertain'),
          });
        }
        if (recorded?.state !== 'completed') throw cause;
      }
    },
    projectPlan: async (projection) => {
      await request({ kind: 'plan-project', projection }, z.null());
    },
    listPlanMilestones: (page) =>
      request({ kind: 'plan-milestones', page }, PlanProjectionResultSchema),
    /** Persists only discovery metadata, not transcript bodies. */
    remember: async (threads: IThreadSummary[], nextCursor: string | null) => {
      await request({ kind: 'remember', threads, nextCursor, observedAt: Date.now() }, z.null());
    },
    getAction: (id) => request({ kind: 'action-read', id }, ActionReceiptSchema.nullable()),
    getThread: (id) => request({ kind: 'thread-read', id }, ManagedThreadSchema.nullable()),
    getThreadByName: (name) =>
      request({ kind: 'thread-name-read', name }, ManagedThreadSchema.nullable()),
    suggestThreadName: (name) =>
      request({ kind: 'thread-name-suggest', name }, ManagedThreadSchema.shape.name),
    getThreadByNativeId: (provider, nativeId) =>
      request({ kind: 'native-thread-read', provider, nativeId }, ManagedThreadSchema.nullable()),
    getNativeThreads: (provider, nativeIds) =>
      request(
        { kind: 'native-threads', provider, nativeIds },
        z.array(ManagedThreadSchema).max(128),
      ),
    listThreads: (workspaceRoot, page) =>
      request({ kind: 'threads', workspaceRoot, page }, ManagedThreadPageSchema),
    listActions: (threadId, page) => request({ kind: 'actions', threadId, page }, ActionPageSchema),
    listProviderActions: (provider, page) =>
      request({ kind: 'provider-actions', provider, page }, ActionPageSchema),
    listApprovals: (threadId, page) =>
      request({ kind: 'approvals', threadId, page }, ApprovalPageSchema),
    listEvents: (page) => request({ kind: 'events', page }, LifecyclePageSchema),
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
