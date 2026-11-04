import { Worker } from 'node:worker_threads';
import { Exception, extractMessage } from 'jg-exception';

import { createPendingRequests } from '../pending/index.js';
import type { IStorageDescriptor } from '../storage/index.js';
import { HQ_ERRORS } from '../errors/index.js';

import type {
  IStore,
  IStoreRequest,
  IStoreResponse,
  IStoreResult,
  IStoreWorkerData,
} from './types.js';
import { toWorkerExecArgv } from './utilities.js';

/**
 * Owns SQLite in one dedicated worker; requests and queued payloads are bounded. Messages between
 * the two threads are built by HQ's own code on both sides, so neither side parses them again.
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
  const workerData: IStoreWorkerData = { databasePath, runtimeEpoch, actionKey };
  const worker = new Worker(new URL('./store.worker.js', import.meta.url), {
    execArgv: toWorkerExecArgv(),
    // indexing a large transcript otherwise grows the young generation to V8's default maximum
    resourceLimits: { maxYoungGenerationSizeMb: 16 },
    workerData,
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
  // the highest session transition sequence the worker reported, and who hears of a new one
  let transitionSequence = 0;
  let onTransition: (() => void) | undefined;
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
  worker.on('message', (response: IStoreResponse) => {
    if (response.kind === 'ready') {
      storage = response.storage;
      transitionSequence = response.transitionSequence;
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
    if (response.transitionSequence !== transitionSequence) {
      transitionSequence = response.transitionSequence;
      onTransition?.();
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

  /**
   * Sends one request and waits for its response, within a deadline unless it has none.
   * @returns The worker's result.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const send = (request: IStoreRequest, timeoutMs: number | undefined): Promise<unknown> => {
    const response = pending.add(
      request.id,
      timeoutMs,
      () =>
        new Exception('The HQ store failed: request deadline exceeded', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
          data: { kind: 'operation-failed' },
        }),
    );
    try {
      worker.postMessage(request);
    } catch (cause) {
      pending.reject(request.id, cause);
    }
    return response;
  };
  /**
   * Admits one more request, IPC, native callbacks and queue dispatch sharing the one worker with
   * bounded headroom.
   * @returns The request's ID.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const admit = (): number => {
    if (!isAvailable || pending.size >= 128)
      throw HQ_ERRORS.create('storeFailed', { data: { kind: 'operation-failed' } });
    return ++sequence;
  };
  return {
    storage: storage!,
    get isAvailable() {
      return isAvailable;
    },
    // a backup steps through the whole database, so it has no deadline
    call: async (model, method, ...args) =>
      (await send(
        { kind: 'call', id: admit(), model, method: String(method), args },
        model === 'snapshot' ? undefined : 5000,
      )) as IStoreResult<typeof model, typeof method>,
    onTransition: (listener) => {
      onTransition = listener;
    },
    close: (): Promise<void> =>
      (closing ??= (async () => {
        try {
          await send({ kind: 'close', id: admit() }, 5000);
          await exited;
        } finally {
          if (!hasExited) await worker.terminate();
          await exited;
        }
      })()),
  };
};
