import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { readClaudeModels } from './index.js';

// a native catalog of the given model IDs
const catalog = (...ids: string[]) => ({
  models: ids.map((id) => ({ value: id, displayName: id, description: `${id} model` })),
});
const command = { kind: 'models' as const, provider: 'claude' as const, limit: 1 };

test('a model cursor continues its request in the catalog revision it was read from', () => {
  const first = readClaudeModels(catalog('a', 'b'), command);
  expect(first.data.map((model) => model.id)).toStrictEqual(['a']);
  const second = readClaudeModels(catalog('a', 'b'), { ...command, cursor: first.nextCursor! });
  expect(second.data.map((model) => model.id)).toStrictEqual(['b']);
  expect(second.nextCursor).toBeNull();
});

test.each([
  ['another request', catalog('a', 'b'), (cursor: string) => ({ ...command, limit: 2, cursor })],
  ['a changed catalog', catalog('a', 'b', 'c'), (cursor: string) => ({ ...command, cursor })],
  [
    'a tampered cursor',
    catalog('a', 'b'),
    (cursor: string) => ({
      ...command,
      cursor: `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`,
    }),
  ],
])('a model cursor fails with CURSOR_INVALID for %s', (_case, input, continuation) => {
  const cursor = readClaudeModels(catalog('a', 'b'), command).nextCursor!;
  expectToThrowCode(
    () => readClaudeModels(input, continuation(cursor)),
    'JG_AGENT_HQ_CURSOR_INVALID',
    'The HQ cursor does not match this request',
  );
});
