import { expect, test } from 'vitest';

import { LiveItems } from './index.js';
import { nativeProvenance } from '../../sessions/evidence/index.js';

const item = {
  nativeId: 'item',
  turnId: 'turn',
  kind: 'agent-message' as const,
  nativeType: 'agentMessage',
  text: 'hello',
  isTruncated: false,
  callId: null,
  outcome: null,
  files: [],
  provenance: nativeProvenance('agent-message'),
  createdAt: null,
};

test('unchanged live reads avoid copying bodies; append, completion, reconciliation and eviction invalidate the revision', () => {
  const live = new LiveItems();
  live.open('thread');
  live.put('thread', item, false);
  const first = live.read('thread');
  expect(first.unchanged).toBe(false);
  expect(live.read('thread', first.revision)).toStrictEqual({
    revision: first.revision,
    unchanged: true,
    data: [],
    hasGap: false,
    backgroundCommands: 0,
  });
  live.append('thread', 'turn', 'item', ' world');
  const appended = live.read('thread', first.revision);
  expect(appended.data[0]?.text).toBe('hello world');
  live.completeTurn('thread', 'turn');
  const completed = live.read('thread', appended.revision);
  expect(completed.data[0]?.state).toBe('awaiting-flush');
  live.reconcile('thread', [{ ...item, text: 'hello world' }]);
  const flushed = live.read('thread', completed.revision);
  expect(flushed.unchanged).toBe(false);
  expect(flushed.data).toStrictEqual([]);
  live.markGap('thread');
  expect(live.read('thread', flushed.revision).hasGap).toBe(true);
  for (let index = 0; index < 32; index++) live.open(`other-${index}`);
  expect(live.read('thread', flushed.revision).unchanged).toBe(false);
  expect(live.read('thread').hasGap).toBe(true);
});

test('a finished command whose saved output the provider shortened is no longer awaiting flush', () => {
  const live = new LiveItems();
  const command = {
    ...item,
    kind: 'command' as const,
    nativeType: 'commandExecution',
    text: `/bin/bash -lc 'cat README.md'\n${'line\n'.repeat(64)}`,
    outcome: 'succeeded' as const,
  };
  live.open('thread');
  live.put('thread', command, true);
  live.reconcile('thread', [
    {
      ...command,
      text: "/bin/bash -lc 'cat README.md'\nline\n... command output truncated for persistence ...\nline\n",
    },
  ]);
  expect(live.read('thread').data).toStrictEqual([]);
});

test.each([
  ['still running', null],
  ['ended otherwise', 'failed'],
] as const)('a finished command stays awaiting flush when its saved copy is %s', (_, outcome) => {
  const live = new LiveItems();
  const command = {
    ...item,
    kind: 'command' as const,
    nativeType: 'commandExecution',
    text: "/bin/bash -lc 'pnpm test'\npassed",
    outcome: 'succeeded' as const,
  };
  live.open('thread');
  live.put('thread', command, true);
  live.reconcile('thread', [{ ...command, text: "/bin/bash -lc 'pnpm test'\n", outcome }]);
  expect(live.read('thread').data).toStrictEqual([{ ...command, state: 'awaiting-flush' }]);
});

test('host provenance enrichment does not keep an already persisted native body awaiting flush', () => {
  const live = new LiveItems();
  const input = {
    ...item,
    kind: 'user-message' as const,
    nativeType: 'userMessage',
    provenance: nativeProvenance('user-message', 'native-input'),
  };
  live.open('thread');
  live.put('thread', input, true);
  live.reconcile('thread', [
    {
      ...input,
      provenance: {
        ...input.provenance,
        source: 'host-action',
        actionId: '00000000-0000-4000-8000-000000000001',
      },
    },
  ]);
  expect(live.read('thread').data).toStrictEqual([]);
});

test('a message its turn ended before the provider finished goes once history holds that turn', () => {
  const live = new LiveItems();
  const answer = { ...item, nativeId: 'answer', text: 'The answer, after the steer' };
  live.open('thread');
  live.put('thread', item, false);
  live.put('thread', answer, true);
  live.completeTurn('thread', 'turn');
  // a page of another turn says nothing about this one
  live.reconcile('thread', [{ ...item, nativeId: 'earlier', turnId: 'earlier-turn' }]);
  expect(live.read('thread').data).toStrictEqual([
    { ...item, state: 'awaiting-flush' },
    { ...answer, state: 'awaiting-flush' },
  ]);
  // the prompt saved before the answer leaves the finished answer waiting for its own copy
  live.reconcile('thread', [{ ...item, nativeId: 'prompt', kind: 'user-message' }]);
  expect(live.read('thread').data).toStrictEqual([{ ...answer, state: 'awaiting-flush' }]);
  live.reconcile('thread', [answer]);
  expect(live.read('thread').data).toStrictEqual([]);
});

test("a turn awaits flush while its window holds a finished item no history page held, and not another turn's", () => {
  const live = new LiveItems();
  live.open('thread');
  expect(live.awaitsFlush('thread', 'turn')).toBe(false);
  // an item still streaming isn't saved yet
  live.put('thread', item, false);
  expect(live.awaitsFlush('thread', 'turn')).toBe(false);
  live.put('thread', { ...item, nativeId: 'other', turnId: 'other-turn' }, true);
  expect(live.awaitsFlush('thread', 'turn')).toBe(false);
  live.put('thread', item, true);
  expect(live.awaitsFlush('thread', 'turn')).toBe(true);
  live.reconcile('thread', [item]);
  expect(live.awaitsFlush('thread', 'turn')).toBe(false);
  expect(live.awaitsFlush('missing', 'turn')).toBe(false);
});

test('an unfinished message the provider finishes after its turn ended waits for its saved copy', () => {
  const live = new LiveItems();
  live.open('thread');
  live.put('thread', item, false);
  live.completeTurn('thread', 'turn');
  live.put('thread', { ...item, text: 'hello world' }, true);
  live.reconcile('thread', [{ ...item, nativeId: 'prompt', kind: 'user-message' }]);
  expect(live.read('thread').data).toStrictEqual([
    { ...item, text: 'hello world', state: 'awaiting-flush' },
  ]);
});

test('the background command count is part of the window: a change invalidates the revision', () => {
  const live = new LiveItems();
  expect(live.read('thread').backgroundCommands).toBe(0);
  live.setBackgroundCommands('thread', 2);
  const started = live.read('thread');
  expect(started.backgroundCommands).toBe(2);
  // the same count changes nothing
  live.setBackgroundCommands('thread', 2);
  expect(live.read('thread', started.revision).unchanged).toBe(true);
  live.setBackgroundCommands('thread', 0);
  expect(live.read('thread', started.revision)).toMatchObject({
    unchanged: false,
    backgroundCommands: 0,
  });
});

test('background counts read without copying a window, and only sessions that run commands are listed', () => {
  const live = new LiveItems();
  expect(live.backgroundCommandsOf('thread')).toBe(0);
  live.setBackgroundCommands('thread', 2);
  live.setBackgroundCommands('other', 0);
  expect(live.backgroundCommandsOf('thread')).toBe(2);
  expect(live.backgroundKeys()).toStrictEqual(['thread']);
  live.setBackgroundCommands('thread', 0);
  expect(live.backgroundKeys()).toStrictEqual([]);
});
