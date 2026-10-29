import { expectToThrowCode } from 'jg-exception/testing';
import { HqRequestSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import type { IHistoryRequest } from '../../sessions/index.js';

import { validateProviderHistory } from './validations.js';

const itemsCommand = (fields: Record<string, unknown>): IHistoryRequest => {
  const command = HqRequestSchema.parse({
    kind: 'items',
    provider: 'codex',
    workspaceRoot: '/workspace',
    nativeId: 'thread-a',
    ...fields,
  });
  if (command.kind !== 'items') throw new Error('wrong command');
  return command;
};
const item = (nativeId: string, turnId: string) => ({
  nativeId,
  turnId,
  nativeType: 'agentMessage',
  kind: 'agent-message',
  provenance: {
    origin: 'agent',
    source: 'native-kind',
    nativeInputId: null,
    nativeInputSha256: null,
    actionId: null,
    contentBoundary: 'untrusted',
    grantsAuthority: false,
  },
  text: 'answer',
  isTruncated: false,
  callId: null,
  outcome: null,
  files: [],
  createdAt: null,
});
const itemsPage = (data: unknown[]) => ({
  kind: 'items',
  result: { data, nextCursor: null, source: 'native', history: 'persisted' },
});

test.each([
  ['an item outside the requested turn', { turnId: 'turn-a' }, [item('item-a', 'turn-b')]],
  [
    'two items for one item read',
    { nativeItemId: 'item-a', turnId: 'turn-a' },
    [item('item-a', 'turn-a'), item('item-b', 'turn-a')],
  ],
  [
    'another item for one item read',
    { nativeItemId: 'item-a', turnId: 'turn-a' },
    [item('item-b', 'turn-a')],
  ],
])('validateProviderHistory rejects %s', (_, fields, data) => {
  expectToThrowCode(
    () => validateProviderHistory(itemsPage(data), itemsCommand(fields), 'codex'),
    'JG_AGENT_HQ_PROVIDER_FAILED',
    'The HQ provider integration failed',
  );
});

test.each([
  ['a page within the requested turn', { turnId: 'turn-a' }, [item('item-a', 'turn-a')]],
  ['the one item read', { nativeItemId: 'item-a', turnId: 'turn-a' }, [item('item-a', 'turn-a')]],
  ['no item for one item read', { nativeItemId: 'item-a', turnId: 'turn-a' }, []],
])('validateProviderHistory accepts %s', (_, fields, data) => {
  expect(validateProviderHistory(itemsPage(data), itemsCommand(fields), 'codex')).toMatchObject({
    kind: 'items',
    result: { data },
  });
});
