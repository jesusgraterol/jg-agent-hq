import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { pageConfigurationChoices } from './index.js';

// native profiles with the given IDs
const choices = (...ids: string[]) =>
  ids.map((id) => ({ kind: 'profile' as const, id, description: null, model: null }));
const command = {
  kind: 'configuration' as const,
  provider: 'codex' as const,
  workspaceRoot: '/workspace',
  limit: 1,
};

test('a configuration cursor continues its request in the inventory revision it was read from', () => {
  const first = pageConfigurationChoices(choices('a', 'b'), command);
  expect(first.choices.map((choice) => choice.id)).toStrictEqual(['a']);
  const second = pageConfigurationChoices(choices('a', 'b'), {
    ...command,
    cursor: first.nextCursor!,
  });
  expect(second.choices.map((choice) => choice.id)).toStrictEqual(['b']);
  expect(second.nextCursor).toBeNull();
});

test.each([
  ['another request', choices('a', 'b'), (cursor: string) => ({ ...command, limit: 2, cursor })],
  ['a changed inventory', choices('a', 'b', 'c'), (cursor: string) => ({ ...command, cursor })],
  [
    'a tampered cursor',
    choices('a', 'b'),
    (cursor: string) => ({
      ...command,
      cursor: `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`,
    }),
  ],
])('a configuration cursor fails with CURSOR_INVALID for %s', (_case, input, continuation) => {
  const cursor = pageConfigurationChoices(choices('a', 'b'), command).nextCursor!;
  expectToThrowCode(
    () => pageConfigurationChoices(input, continuation(cursor)),
    'JG_AGENT_HQ_CURSOR_INVALID',
    'The HQ cursor does not match this request',
  );
});
