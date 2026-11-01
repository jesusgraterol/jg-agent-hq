import { expect, test } from 'vitest';

import { Resyncs } from './resync.js';
import type { IResyncRequest } from './types.js';

const fresh = (lost: IResyncRequest['lost']): IResyncRequest => ({
  lost,
  isLastAttempt: false,
  turnId: null,
});

// re-checks the test finishes one by one, recording what ran and how many ran at once
const createRechecks = () => {
  const started: { provider: string; nativeId: string; request: IResyncRequest }[] = [];
  const finishers: (() => void)[] = [];
  let running = 0;
  let mostRunning = 0;
  const background: Promise<void>[] = [];
  const resyncs = new Resyncs(
    (provider, nativeId, request) =>
      new Promise((resolve) => {
        started.push({ provider, nativeId, request });
        running += 1;
        mostRunning = Math.max(mostRunning, running);
        finishers.push(() => {
          running -= 1;
          resolve();
        });
      }),
    (operation) => {
      background.push(operation());
    },
  );
  const finishNext = async () => {
    finishers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { resyncs, started, finishNext, mostRunning: () => mostRunning, background };
};

test('a provider runs its re-checks one at a time, in the order they were asked for', async () => {
  const { resyncs, started, finishNext, mostRunning } = createRechecks();
  resyncs.request('codex', 'thread-a', fresh('turn-completed'));
  resyncs.request('codex', 'thread-b', fresh('unknown'));
  resyncs.request('codex', 'thread-c', fresh('unknown'));
  expect(started.map((entry) => entry.nativeId)).toStrictEqual(['thread-a']);
  await finishNext();
  await finishNext();
  await finishNext();
  expect(started.map((entry) => entry.nativeId)).toStrictEqual([
    'thread-a',
    'thread-b',
    'thread-c',
  ]);
  expect(mostRunning()).toBe(1);
});

test('requests for a session merge into its waiting re-check, and one asked while it runs follows once', async () => {
  const { resyncs, started, finishNext } = createRechecks();
  resyncs.request('codex', 'thread-a', fresh('unknown'));
  resyncs.request('codex', 'thread-b', fresh('unknown'));
  resyncs.request('codex', 'thread-b', fresh('approval-resolved'));
  // thread-a runs, so these two become one follow-up after it
  resyncs.request('codex', 'thread-a', fresh('turn-started'));
  resyncs.request('codex', 'thread-a', fresh('turn-completed'));
  await finishNext();
  await finishNext();
  await finishNext();
  expect(started.map(({ nativeId, request }) => [nativeId, request.lost])).toStrictEqual([
    ['thread-a', 'unknown'],
    ['thread-b', 'approval-resolved'],
    ['thread-a', 'turn-completed'],
  ]);
});

test('each provider has its own re-check order', async () => {
  const { resyncs, started, finishNext } = createRechecks();
  resyncs.request('codex', 'thread-a', fresh('unknown'));
  resyncs.request('other', 'thread-a', fresh('unknown'));
  expect(started.map((entry) => entry.provider)).toStrictEqual(['codex', 'other']);
  await finishNext();
  await finishNext();
});
