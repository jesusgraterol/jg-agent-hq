import { expect, test } from 'vitest';

import { toHistoryItem, toSessionState } from './index.js';

test('native MCP tool activity retains its identity, input and bounded output', () => {
  const item = toHistoryItem({
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
  });
  expect(item.kind).toBe('tool');
  expect(item.text).toContain('docs/lookup (completed)');
  expect(item.text).toContain('"query":"protocol"');
  expect(item.isTruncated).toBe(true);
  const last = item.text.charCodeAt(item.text.length - 1);
  expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
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
