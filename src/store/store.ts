import { Worker } from 'node:worker_threads';
import { Exception, extractMessage } from 'error-message-utils';

import type { IThreadSummary } from '../contracts/index.js';

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
export const createStore = async (databasePath: string, runtimeEpoch: string): Promise<IStore> => {
  const worker = new Worker(new URL('./store.worker.js', import.meta.url), {
    // the worker loads a file, even when its caller used Node's string-input mode
    execArgv: process.execArgv.filter(
      (argument, index, arguments_) =>
        argument !== '--input-type' &&
        !argument.startsWith('--input-type=') &&
        arguments_[index - 1] !== '--input-type',
    ),
    workerData: { databasePath, runtimeEpoch },
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
    { resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
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
        new Exception(`The HQ store failed: ${response.error}`, undefined, {
          kind: 'operation-failed',
        }),
      );
    else entry.resolve();
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

  const request = (command: IStoreCommand): Promise<void> => {
    if (!isAvailable || pending.size >= 32)
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
      pending.set(id, { resolve, reject, timer });
      worker.postMessage(parsed.data);
    });
  };
  return {
    get isAvailable() {
      return isAvailable;
    },
    /** Persists only discovery metadata, not transcript bodies. */
    remember: (threads: IThreadSummary[], nextCursor: string | null) =>
      request({ kind: 'remember', threads, nextCursor, observedAt: Date.now() }),
    close: (): Promise<void> =>
      (closing ??= (async () => {
        try {
          await request({ kind: 'close' });
          await exited;
        } finally {
          if (!hasExited) await worker.terminate();
          await exited;
        }
      })()),
  };
};
