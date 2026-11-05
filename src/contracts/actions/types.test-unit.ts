import { ActionCommandSchema, ManagedThreadSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

const threadId = '0b5e2c4a-7b84-4d6c-9a52-3f1d6a8e9c10';

test.each([
  [1, true],
  [32, true],
  [33, true],
  [64, true],
  [65, false],
])('action and managed-thread names of length %d -> %s', (length, isAccepted) => {
  const name = 'a'.repeat(length);
  for (const command of [
    { kind: 'thread-create', provider: 'codex', workspaceRoot: '/work', name },
    {
      kind: 'thread-adopt',
      provider: 'claude',
      workspaceRoot: '/work',
      nativeId: threadId,
      operatorConfirmation: 'The native CLI is closed',
      name,
    },
    { kind: 'thread-rename', threadId, name },
  ]) {
    expect(ActionCommandSchema.safeParse(command).success).toBe(isAccepted);
  }
  expect(
    ManagedThreadSchema.safeParse({
      id: threadId,
      provider: 'codex',
      nativeId: 'native-one',
      nativeLineage: null,
      name,
      workspaceRoot: '/work',
      ownership: 'managed',
      runtimeEpoch: threadId,
      activeTurnId: null,
      state: 'idle',
      createdAt: 1,
      updatedAt: 1,
    }).success,
  ).toBe(isAccepted);
});

test.each(['', '-task', 'Task', 'two words', 'two_words', 'a/b', 'café', 'task\n'])(
  'action and managed-thread names reject %j',
  (name) => {
    expect(ActionCommandSchema.safeParse({ kind: 'thread-rename', threadId, name }).success).toBe(
      false,
    );
    expect(ManagedThreadSchema.shape.name.safeParse(name).success).toBe(false);
  },
);

test.each(['1', '1-task', 'task-'])('names preserve the existing valid syntax %s', (name) => {
  expect(ActionCommandSchema.parse({ kind: 'thread-rename', threadId, name })).toMatchObject({
    name,
  });
});
