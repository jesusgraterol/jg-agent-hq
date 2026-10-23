import { ProviderCapabilitySchema, ProviderIdSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

test.each([
  ['codex', true],
  ['claude', true],
  ['review-provider', true],
  ['provider-' + 'a'.repeat(55), true],
  ['provider-' + 'a'.repeat(56), false],
  ['Provider', false],
  ['../provider', false],
  ['', false],
])('ProviderIdSchema(%s) -> accepted=%s', (provider, accepted) => {
  expect(ProviderIdSchema.safeParse(provider).success).toBe(accepted);
});

test('unsupported and unknown capability observations cannot imply supported control', () => {
  expect(
    ProviderCapabilitySchema.safeParse({ state: 'unknown', changeMode: 'live', reason: null })
      .success,
  ).toBe(false);
  expect(
    ProviderCapabilitySchema.safeParse({ state: 'unsupported', changeMode: null, reason: null })
      .success,
  ).toBe(false);
  expect(
    ProviderCapabilitySchema.parse({
      state: 'supported',
      changeMode: 'idle-restart',
      reason: null,
      futureObservation: { value: true },
    }),
  ).toStrictEqual({ state: 'supported', changeMode: 'idle-restart', reason: null });
});
