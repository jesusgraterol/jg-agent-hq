import { randomUUID } from 'node:crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import { afterEach, expect, test, vi } from 'vitest';

import type { IActionReceipt } from '../../contracts/index.js';

import { ActionWaits } from './index.js';

const receipt = (fields: Partial<IActionReceipt> = {}): IActionReceipt => ({
  id: randomUUID(),
  digest: 'a'.repeat(64),
  runtimeEpoch: randomUUID(),
  kind: 'thread-create',
  provider: 'codex',
  controlState: null,
  threadId: 'thread-1',
  nativeThreadId: null,
  nativeTurnId: null,
  nativeRequestId: null,
  delivery: 'submitted',
  completion: null,
  failure: null,
  relatedActionId: null,
  queuedInput: null,
  result: null,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

/*
 * A store whose receipt the test changes. Each read stays pending until the test answers it, so
 * the test decides what a read observes, and the mock counts how often the waits read.
 */
const createStore = (initial: IActionReceipt | null) => {
  let current = initial;
  const pending: (() => void)[] = [];
  const read = vi.fn(
    (_actionId: string) =>
      new Promise<IActionReceipt | null>((resolve) => {
        pending.push(() => resolve(current));
      }),
  );
  // one event-loop turn, in which every pending promise continuation runs
  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    read,
    set: (next: IActionReceipt) => {
      current = next;
    },
    // answers every pending read with the current receipt, then lets the waits handle the answers
    answer: async () => {
      await drain();
      expect(pending.length).toBeGreaterThan(0);
      for (const resolve of pending.splice(0)) resolve();
      await drain();
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

test('a native wait returns once the receipt has a native thread ID, reading only after its notifications', async () => {
  const initial = receipt();
  const store = createStore(initial);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(initial.id, 'native', 30_000);
  await store.answer();
  // changes to another action's receipt, or another thread's, never wake this wait
  waits.notifyAction(randomUUID());
  waits.notifyThread('thread-2');
  expect(store.read).toHaveBeenCalledTimes(1);
  store.set({ ...initial, nativeThreadId: 'native-1' });
  waits.notifyAction(initial.id);
  await store.answer();
  expect(await waiting).toStrictEqual({
    receipt: { ...initial, nativeThreadId: 'native-1' },
    isTimedOut: false,
  });
  expect(store.read).toHaveBeenCalledTimes(2);
});

test.each(['acknowledged', 'uncertain', 'failed', 'canceled'] as const)(
  'a settled wait ends on its thread notification once the delivery is %s',
  async (delivery) => {
    const initial = receipt({ kind: 'message', nativeThreadId: 'native-1' });
    const store = createStore(initial);
    const waits = new ActionWaits(store.read);
    const waiting = waits.wait(initial.id, 'settled', 30_000);
    await store.answer();
    store.set({ ...initial, delivery });
    waits.notifyThread('thread-1');
    await store.answer();
    expect(await waiting).toStrictEqual({ receipt: { ...initial, delivery }, isTimedOut: false });
    expect(store.read).toHaveBeenCalledTimes(2);
  },
);

test('a native wait also ends once the receipt settles without a native thread ID', async () => {
  const initial = receipt();
  const store = createStore(initial);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(initial.id, 'native', 30_000);
  await store.answer();
  store.set({ ...initial, delivery: 'failed', failure: 'agent-unavailable' });
  waits.notifyAll();
  await store.answer();
  expect(await waiting).toStrictEqual({
    receipt: { ...initial, delivery: 'failed', failure: 'agent-unavailable' },
    isTimedOut: false,
  });
});

test('a notification while a read is in flight reads the receipt again instead of being missed', async () => {
  const initial = receipt();
  const store = createStore(initial);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(initial.id, 'settled', 30_000);
  expect(store.read).toHaveBeenCalledTimes(1);
  // the first read hasn't returned the receipt's thread yet, so only the read in flight matches
  waits.notifyThread('thread-1');
  await store.answer();
  store.set({ ...initial, delivery: 'acknowledged' });
  await store.answer();
  expect(await waiting).toStrictEqual({
    receipt: { ...initial, delivery: 'acknowledged' },
    isTimedOut: false,
  });
  expect(store.read).toHaveBeenCalledTimes(2);
});

test('a wait returns the current receipt with isTimedOut once its time runs out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const initial = receipt({ delivery: 'queued' });
  const store = createStore(initial);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(initial.id, 'settled', 1_000);
  await store.answer();
  await vi.advanceTimersByTimeAsync(999);
  expect(store.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await store.answer();
  expect(await waiting).toStrictEqual({ receipt: initial, isTimedOut: true });
  expect(store.read).toHaveBeenCalledTimes(2);
});

test('an unknown action resolves at once with a null receipt', async () => {
  const store = createStore(null);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(randomUUID(), 'settled', 30_000);
  await store.answer();
  expect(await waiting).toStrictEqual({ receipt: null, isTimedOut: false });
});

test('closing ends a pending wait and refuses a new one without reading', async () => {
  const initial = receipt();
  const store = createStore(initial);
  const waits = new ActionWaits(store.read);
  const waiting = waits.wait(initial.id, 'settled', 30_000);
  await store.answer();
  waits.close();
  await expectToRejectCode(
    waiting,
    'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
    'The HQ runtime is not running',
  );
  await expectToRejectCode(
    waits.wait(initial.id, 'native', 30_000),
    'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
    'The HQ runtime is not running',
  );
  expect(store.read).toHaveBeenCalledTimes(1);
});
