import { MAX_PAGE_SIZE, UsageSnapshotSchema, type IUsageSnapshot } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

const minimal: IUsageSnapshot = {
  provider: 'custom-provider',
  source: 'native',
  state: 'available',
  observedAt: 1_000,
  ordinaryUsageAllowed: null,
  windows: [
    {
      id: 'custom:primary',
      bucket: 'custom',
      label: null,
      window: 'primary',
      usedPercent: 25,
      remainingPercent: 75,
      durationMinutes: null,
      resetsAt: null,
    },
  ],
};

test('observations without optional metadata remain valid without injecting required properties', () => {
  expect(UsageSnapshotSchema.parse(minimal)).toStrictEqual(minimal);
});

test('usage retains exact credit strings and scoped meters while accepting additive metadata', () => {
  const snapshot = {
    ...minimal,
    credits: [
      { bucket: 'custom', hasCredits: true, isUnlimited: false, balance: '0.29000000000000001' },
    ],
    resetCredits: { availableCount: 0 },
    windows: minimal.windows.map((window) => ({
      ...window,
      period: 'seven-day',
      nativeKind: 'weekly_model',
      group: 'weekly',
      scope: { model: { id: null, displayName: 'Model' }, surface: 'code' },
    })),
  };
  expect(UsageSnapshotSchema.parse({ ...snapshot, futureProperty: true })).toStrictEqual(snapshot);
});

test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
  'usage rejects invalid reset availability %s',
  (availableCount) => {
    expect(
      UsageSnapshotSchema.safeParse({ ...minimal, resetCredits: { availableCount } }).success,
    ).toBe(false);
  },
);

test('credit inventories and new native strings retain explicit public bounds', () => {
  const credit = { bucket: 'custom', hasCredits: false, isUnlimited: false, balance: '0' };
  expect(
    UsageSnapshotSchema.safeParse({ ...minimal, credits: Array(MAX_PAGE_SIZE).fill(credit) })
      .success,
  ).toBe(true);
  expect(
    UsageSnapshotSchema.safeParse({ ...minimal, credits: Array(MAX_PAGE_SIZE + 1).fill(credit) })
      .success,
  ).toBe(false);
  expect(
    UsageSnapshotSchema.safeParse({
      ...minimal,
      credits: [{ ...credit, balance: '1'.repeat(257) }],
    }).success,
  ).toBe(false);
});
