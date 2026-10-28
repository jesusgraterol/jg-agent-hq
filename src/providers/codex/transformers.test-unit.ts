import { expect, test } from 'vitest';

import { toHistoryItem, toSessionState } from './index.js';

test('native MCP tool activity retains its identity, input and bounded output', () => {
  const item = toHistoryItem(
    {
      turnId: 'turn',
      item: {
        id: 'call',
        type: 'mcpToolCall',
        server: 'docs',
        tool: 'lookup',
        status: 'completed',
        arguments: { query: 'protocol' },
        result: { content: '🧪'.repeat(40_000) },
      },
    },
    undefined,
  )!;
  expect(item.kind).toBe('tool');
  expect(item.text).toContain('docs/lookup (completed)');
  expect(item.text).toContain('"query":"protocol"');
  expect(item.isTruncated).toBe(true);
  const last = item.text.charCodeAt(item.text.length - 1);
  expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
});

const present = (item: { type: string } & Record<string, unknown>) => {
  const presented = toHistoryItem({ turnId: 'turn', item: { id: 'item', ...item } }, undefined);
  return (
    presented && {
      kind: presented.kind,
      text: presented.text,
      callId: presented.callId,
      outcome: presented.outcome,
      files: presented.files,
    }
  );
};

test.each([
  ['userMessage', 'completed', { startedAt: 1_000, completedAt: 9_000 }, 1_000],
  ['agentMessage', 'completed', { startedAt: 1_000, completedAt: 9_000 }, 9_000],
  ['commandExecution', 'completed', { startedAt: 1_000, completedAt: 9_000 }, 9_000],
  ['userMessage', 'running', { startedAt: 1_000, completedAt: null }, 1_000],
  ['agentMessage', 'running', { startedAt: 1_000, completedAt: null }, 1_000],
  ['agentMessage', 'untimed', { startedAt: null, completedAt: null }, null],
  ['agentMessage', 'unknown', undefined, null],
])('toHistoryItem(%s, %s turn) -> createdAt %s', (type, _turnState, turn, createdAt) => {
  const item =
    type === 'userMessage'
      ? { id: 'item', type, content: [{ type: 'text', text: 'Fix it' }] }
      : type === 'agentMessage'
        ? { id: 'item', type, text: 'Done' }
        : { id: 'item', type, command: 'ls', aggregatedOutput: '', status: 'completed' };
  expect(toHistoryItem({ turnId: 'turn', item }, turn)?.createdAt).toBe(createdAt);
});

test('reasoning is left out as it is read', () => {
  expect(present({ type: 'reasoning', summary: ['plan'], content: ['private'] })).toBeNull();
});

test.each([
  [{ type: 'contextCompaction' }, 'notice', ''],
  [
    { type: 'webSearch', query: 'zod strictObject', action: null, results: null },
    'tool',
    'zod strictObject',
  ],
  [{ type: 'imageView', path: '/workspace/screen.png' }, 'tool', '/workspace/screen.png'],
  [{ type: 'hookPrompt', fragments: [] }, 'unsupported', ''],
])('toHistoryItem(%o) -> %s', (item, kind, text) => {
  expect(present(item)).toStrictEqual({ kind, text, callId: null, outcome: null, files: [] });
});

test.each([
  ['completed', 'succeeded'],
  ['failed', 'failed'],
  ['declined', 'failed'],
  ['inProgress', null],
  ['futureStatus', null],
])('a command with status %s -> %s', (status, outcome) => {
  expect(
    present({ type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.ts', status })?.outcome,
  ).toBe(outcome);
});

test.each([
  ['mcpToolCall', 'completed', 'succeeded'],
  ['mcpToolCall', 'failed', 'failed'],
  ['dynamicToolCall', 'inProgress', null],
  ['fileChange', 'declined', 'failed'],
])('a %s with status %s -> %s', (type, status, outcome) => {
  expect(present({ type, status, tool: 'lookup', arguments: {}, changes: [] })?.outcome).toBe(
    outcome,
  );
});

test('a change of several files counts each file from its full diff', () => {
  const updated = Array.from({ length: 200 }, (_, index) => `+added line ${index}`);
  const item = present({
    type: 'fileChange',
    status: 'completed',
    changes: [
      {
        path: '/workspace/a.ts',
        kind: { type: 'update', move_path: null },
        diff: [
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1,2 +1,201 @@',
          ' kept',
          '-removed',
          ...updated,
        ].join('\n'),
      },
      { path: '/workspace/b.ts', kind: { type: 'add' }, diff: 'one\ntwo\nthree\n' },
      { path: '/workspace/c.ts', kind: { type: 'delete' }, diff: 'gone\n' },
    ],
  });
  expect(item?.files).toStrictEqual([
    { path: '/workspace/a.ts', added: 200, removed: 1 },
    { path: '/workspace/b.ts', added: 3, removed: 0 },
    { path: '/workspace/c.ts', added: 0, removed: 1 },
  ]);
  expect(item?.outcome).toBe('succeeded');
});

test.each([
  [{ type: 'active', activeFlags: [] }, 'running'],
  [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'waiting'],
  [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'waiting'],
  [{ type: 'idle' }, 'idle'],
  [{ type: 'notLoaded' }, 'closed'],
  [{ type: 'systemError' }, 'failed'],
] as const)('toSessionState(%o) -> %s', (status, state) => {
  expect(
    toSessionState({
      ...status,
      activeFlags: 'activeFlags' in status ? [...status.activeFlags] : undefined,
    }),
  ).toBe(state);
});
