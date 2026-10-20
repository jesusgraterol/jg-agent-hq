import { Worker } from 'node:worker_threads';
import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import {
  ActionReceiptSchema,
  ActionPlanContextSchema,
  ManagedThreadSchema,
  type IThreadSummary,
} from '../contracts/index.js';
import { ClaudeHistoryReadSchema } from '../providers/claude/history/index.js';

import {
  PlanWriteIntentSchema,
  PlanProjectionResultSchema,
  PlanRevisionPageResultSchema,
} from '../plans/index.js';

import {
  AdmissionResultSchema,
  ObservationResultSchema,
  DispatchSchema,
  ManagedThreadPageSchema,
  ActionPageSchema,
  LifecyclePageSchema,
  ApprovalIdentitySchema,
} from './control/index.js';
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
 * - -1: The HQ store failed
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
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let sequence = 0;
  let isAvailable = true;
  let closing: Promise<void> | undefined;
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = (cause: unknown): void => {
    isAvailable = false;
    const error = new Exception(
      `The HQ store failed: ${extractMessage(cause)}`,
      undefined,
      { kind: 'operation-failed' },
      { cause },
    );
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
      readyResolve();
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(response.id);
    if (response.error)
      entry.reject(
        new Exception(response.error.message, undefined, {
          kind: response.error.kind,
        }),
      );
    else entry.resolve(response.result);
  });
  worker.once('error', fail);
  worker.once('exit', (code) =>
    fail(new Exception(`The HQ store failed: worker exited (${code})`)),
  );
  const timer = setTimeout(
    () => fail(new Exception('The HQ store failed: startup deadline exceeded')),
    5000,
  );
  try {
    await ready;
  } catch (error) {
    try {
      await worker.terminate();
      await exited;
    } catch (cleanup) {
      throw new Exception(
        `The HQ store failed: ${extractMessage(cleanup)}`,
        undefined,
        { kind: 'operation-failed', cleanupUnconfirmed: true },
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const request = <T>(command: IStoreCommand, schema: z.ZodType<T>): Promise<T> => {
    // IPC, native callbacks and queue dispatch share the one worker, with bounded headroom.
    if (!isAvailable || pending.size >= 128)
      return Promise.reject(
        new Exception('The HQ store failed', undefined, { kind: 'operation-failed' }),
      );
    const id = ++sequence;
    const parsed = StoreRequestSchema.safeParse({ id, command });
    if (!parsed.success)
      return Promise.reject(
        new Exception(
          'The HQ store failed',
          undefined,
          { kind: 'operation-failed' },
          { cause: parsed.error },
        ),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Exception('The HQ store failed: request deadline exceeded', undefined, {
            kind: 'operation-failed',
          }),
        );
      }, 5000);
      pending.set(id, {
        resolve: (result) => {
          const checked = schema.safeParse(result);
          if (checked.success) resolve(checked.data);
          else
            reject(
              new Exception(
                'The HQ store failed',
                undefined,
                { kind: 'operation-failed' },
                { cause: checked.error },
              ),
            );
        },
        reject,
        timer,
      });
      worker.postMessage(parsed.data);
    });
  };
  return {
    get isAvailable() {
      return isAvailable;
    },
    readClaudeHistory: (command) =>
      request({ kind: 'claude-history', request: command }, ClaudeHistoryReadSchema),
    projectPlanRevision: async (projection) => {
      await request({ kind: 'plan-revision-project', projection }, z.null());
    },
    listPlanRevision: (page) =>
      request({ kind: 'plan-revision-page', page }, PlanRevisionPageResultSchema),
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
      await request({ kind: 'plan-complete', id }, z.null());
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
