import {
  AsyncInputSchema,
  AsyncQuestionSchema,
  MAX_ASYNC_INPUT_BYTES,
} from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

test('the browser-safe async contract bounds serialized UTF-8 and JSON escaping without shortening choices', () => {
  const question = { title: 'Pick one', options: ['🐈'.repeat(4096), '🐈'.repeat(4096)] };
  expect(AsyncQuestionSchema.safeParse(question).success).toBe(true);
  const payload = { state: 'available', delivery: 'async', questions: [question] };
  expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeGreaterThan(
    MAX_ASYNC_INPUT_BYTES,
  );
  expect(AsyncInputSchema.safeParse(payload).success).toBe(false);
  expect(
    AsyncInputSchema.parse({
      state: 'unavailable',
      delivery: 'async',
      reason: 'too-large',
      future: true,
    }),
  ).toStrictEqual({
    state: 'unavailable',
    delivery: 'async',
    reason: 'too-large',
  });
  expect(
    AsyncInputSchema.parse({
      state: 'available',
      delivery: 'async',
      questions: [{ title: 'Other details?', future: true }],
    }),
  ).toStrictEqual({
    state: 'available',
    delivery: 'async',
    questions: [{ title: 'Other details?' }],
  });
});
