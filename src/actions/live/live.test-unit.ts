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
  provenance: nativeProvenance('agent-message'),
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
