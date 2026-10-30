// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HqResponseSchema } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  countHeldDelays,
  releaseHeldDelays,
  startHoldingDelays,
  withClaudeRuntime,
} from '../../../scripts/test-support/index.js';

// the read process's 5-minute idle period is released by the test instead of waited out
vi.mock('jg-utilities', async (original) => {
  const actual = await original<typeof import('jg-utilities')>();
  const { holdDelays } = await import('../../../scripts/test-support/delays.js');
  return { ...actual, delay: holdDelays(actual.delay) };
});
startHoldingDelays(300);

// the session-less read processes the fixture started, in order
const readPids = async (root: string): Promise<number[]> =>
  (await readFile(join(root, 'claude-read-pids.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => z.object({ pid: z.number().int() }).parse(JSON.parse(line)).pid);

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// runs a step on a frozen clock that only the step moves, restoring the real one before teardown
const withFrozenClock = async (run: () => Promise<void>): Promise<void> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

// a usage result answers reads for 60 seconds, so a test moves the clock past it to ask Claude
const expireUsage = (): void => {
  vi.setSystemTime(Date.now() + 60_000);
};

test('native usage preserves independent account windows and never sends a user prompt or scans behavior', async () => {
  await withClaudeRuntime(async ({ root, request }) => {
    for (let index = 0; index < 2; index += 1) {
      const response = HqResponseSchema.parse(await request({ kind: 'usage', provider: 'claude' }));
      expect(response.kind).toBe('usage');
      if (response.kind !== 'usage') throw new Error('wrong response');
      expect(response.result.provider).toBe('claude');
      expect(response.result.state).toBe('available');
      expect(response.result.windows.map((window) => window.usedPercent)).toStrictEqual([25, 60]);
      expect(response.result.windows.map((window) => window.remainingPercent)).toStrictEqual([
        75, 40,
      ]);
      expect(response.result.windows[1]?.resetsAt).toBeNull();
      expect(response.result.windows.map((window) => window.period)).toStrictEqual([
        'five-hour',
        'seven-day',
      ]);
      expect(response.result.windows.map((window) => window.durationMinutes)).toStrictEqual([
        300, 10080,
      ]);
      expect(response.result.windows[1]?.scope).toStrictEqual({
        model: { id: null, displayName: 'Example' },
        surface: null,
      });
      expect(response.result.credits).toBeNull();
      expect(response.result.resetCredits).toBeNull();
      expect(response.result.ordinaryUsageAllowed).toBeNull();
    }
    const calls = (await readFile(join(root, 'claude-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) =>
        z
          .object({
            type: z.literal('control_request'),
            request: z.object({ subtype: z.string(), skip_behaviors: z.boolean().optional() }),
          })
          .parse(JSON.parse(line)),
      );
    // the second read was answered by the first one's kept result
    expect(calls.map((call) => call.request.subtype)).toStrictEqual(['initialize', 'get_usage']);
    expect(calls.slice(1).every((call) => call.request.skip_behaviors === true)).toBe(true);
  });
});

test('independent Claude weekly scopes and unknown groups retain native identity', async () => {
  await withClaudeRuntime(async ({ request, control }) => {
    await control({
      rows: [
        {
          kind: 'weekly',
          group: 'weekly',
          percent: 20,
          resets_at: '2033-05-18T03:33:20.000Z',
          scope: null,
          is_active: true,
        },
        {
          kind: 'weekly_model',
          group: 'weekly',
          percent: 60,
          resets_at: null,
          scope: { model: { id: 'model-a', display_name: 'Model A' }, surface: 'code' },
          is_active: false,
        },
        {
          kind: 'future_meter',
          group: 'future',
          percent: 120,
          resets_at: null,
          scope: { model: null, surface: 'cli' },
          is_active: false,
        },
      ],
    });
    const observed = await request({ kind: 'usage', provider: 'claude' });
    if (observed.kind !== 'usage') throw new Error('wrong response');
    expect(observed.result.state).toBe('available');
    expect(
      observed.result.windows.map(
        ({ period, group, nativeKind, scope, durationMinutes, resetsAt }) => ({
          period,
          group,
          nativeKind,
          scope,
          durationMinutes,
          resetsAt,
        }),
      ),
    ).toStrictEqual([
      {
        period: 'seven-day',
        group: 'weekly',
        nativeKind: 'weekly',
        scope: null,
        durationMinutes: 10080,
        resetsAt: 2_000_000_000_000,
      },
      {
        period: 'seven-day',
        group: 'weekly',
        nativeKind: 'weekly_model',
        scope: { model: { id: 'model-a', displayName: 'Model A' }, surface: 'code' },
        durationMinutes: 10080,
        resetsAt: null,
      },
      {
        period: 'other',
        group: 'future',
        nativeKind: 'future_meter',
        scope: { model: null, surface: 'cli' },
        durationMinutes: null,
        resetsAt: null,
      },
    ]);
    expect(new Set(observed.result.windows.map((window) => window.id)).size).toBe(3);
    await control({ failure: true });
    await withFrozenClock(async () => {
      expireUsage();
      expect(await request({ kind: 'usage', provider: 'claude' })).toStrictEqual({
        kind: 'usage',
        result: { ...observed.result, state: 'stale' },
      });
    });
  });
});

test('failed observations stay stale; account changes discard every prior-account window', async () => {
  await withClaudeRuntime(({ request, control }) =>
    withFrozenClock(async () => {
      const first = await request({ kind: 'usage', provider: 'claude' });
      expect(first.kind === 'usage' && first.result.state).toBe('available');
      await control({ failure: true });
      expireUsage();
      const stale = await request({ kind: 'usage', provider: 'claude' });
      expect(stale.kind === 'usage' && stale.result.state).toBe('stale');
      expect(
        stale.kind === 'usage' && stale.result.windows.map((window) => window.usedPercent),
      ).toStrictEqual([25, 60]);
      await control({ authChange: true });
      expireUsage();
      const changed = await request({ kind: 'usage', provider: 'claude' });
      expect(changed.kind === 'usage' && changed.result.state).toBe('unavailable');
      expect(changed.kind === 'usage' && changed.result.windows).toStrictEqual([]);
      await control({
        rows: [
          {
            kind: 'session',
            group: 'session',
            percent: 7,
            resets_at: null,
            scope: null,
            is_active: true,
          },
        ],
      });
      // the account change during the last read kept its result from answering this one
      const fresh = await request({ kind: 'usage', provider: 'claude' });
      expect(
        fresh.kind === 'usage' && fresh.result.windows.map((window) => window.usedPercent),
      ).toStrictEqual([7]);
    }),
  );
});

test('a usage result answers reads for 60 seconds, after which the next read asks Claude again', async () => {
  await withClaudeRuntime(({ root, request, control }) =>
    withFrozenClock(async () => {
      const usageRequests = async () =>
        (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).split('get_usage').length - 1;
      const first = await request({ kind: 'usage', provider: 'claude' });
      expect(first.kind === 'usage' && first.result.state).toBe('available');
      await control({
        rows: [
          {
            kind: 'session',
            group: 'session',
            percent: 7,
            resets_at: null,
            scope: null,
            is_active: true,
          },
        ],
      });
      vi.setSystemTime(Date.now() + 59_999);
      expect(await request({ kind: 'usage', provider: 'claude' })).toStrictEqual(first);
      expect(await usageRequests()).toBe(1);
      vi.setSystemTime(Date.now() + 1);
      const refreshed = await request({ kind: 'usage', provider: 'claude' });
      expect(
        refreshed.kind === 'usage' && refreshed.result.windows.map((window) => window.usedPercent),
      ).toStrictEqual([7]);
      expect(await usageRequests()).toBe(2);
    }),
  );
});

test.each([
  [{ unavailable: true }, 'unavailable'],
  [{ rows: [] }, 'unavailable'],
  [
    {
      rows: [{ kind: 'session', group: 'session', resets_at: null, scope: null, is_active: true }],
    },
    'unavailable',
  ],
  [
    {
      rows: [
        {
          kind: 'session',
          group: 'session',
          percent: 0,
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ],
    },
    'available',
  ],
  [{ rateEvent: true }, 'available'],
  [
    {
      rows: [
        {
          kind: 'session',
          group: 'session',
          percent: null,
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ],
    },
    'unavailable',
  ],
  [{ expired: true }, 'stale'],
  [
    {
      rows: [
        {
          kind: 'session',
          group: 'session',
          percent: 100,
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ],
    },
    'exhausted',
  ],
  [
    {
      rows: [
        {
          kind: 'session',
          group: 'session',
          percent: 'invalid',
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ],
    },
    'unavailable',
  ],
  [{ malformed: true }, 'unavailable'],
])('usage(%o) -> %s', async (settings, state) => {
  await withClaudeRuntime(async ({ request, control }) => {
    await control(settings);
    const response = await request({ kind: 'usage', provider: 'claude' });
    expect(response.kind === 'usage' && response.result.state).toBe(state);
  });
});

test('shutdown rejects a held native usage request and confirms the owned process has exited', async () => {
  await withClaudeRuntime(async ({ root, runtime, control }) => {
    await control({ hold: true });
    const pending = runtime.request({ kind: 'usage', provider: 'claude' });
    await expect
      .poll(async () =>
        (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).includes('get_usage'),
      )
      .toBe(true);
    await runtime.close();
    const response = await pending;
    expect(response.kind === 'usage' && response.result.state).toBe('unavailable');
  });
});

test('the session-less read process closes after 5 minutes unused and opens again on the next read', async () => {
  await withClaudeRuntime(async ({ root, request }) => {
    const claudeStatus = async () => {
      const status = await request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      return status.result.providers.find((provider) => provider.provider === 'claude');
    };
    await request({ kind: 'usage', provider: 'claude' });
    await request({ kind: 'models', provider: 'claude' });
    const [pid] = await readPids(root);
    expect(await readPids(root)).toHaveLength(1);
    // the second read restarted the idle period, so one wait remains
    await expect.poll(() => countHeldDelays(300)).toBe(1);
    expect(releaseHeldDelays(300)).toBe(1);
    await expect.poll(() => isRunning(pid!)).toBe(false);
    // the adapter reads as unused, keeping the version it observed
    expect(await claudeStatus()).toStrictEqual({
      provider: 'claude',
      state: 'idle',
      version: '2.1.304',
    });
    // closing the process also ended the kept usage result
    expect(await request({ kind: 'usage', provider: 'claude' })).toMatchObject({
      kind: 'usage',
      result: { state: 'available' },
    });
    expect(await readPids(root)).toHaveLength(2);
  });
});

test('history reads keep the first successful check instead of starting a claude process again', async () => {
  await withClaudeRuntime(async ({ root, workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    await writeFile(
      transcript(nativeId),
      `${JSON.stringify(claudeRecord(workspaceRoot, nativeId))}\n`,
    );
    expect(await request({ kind: 'threads', provider: 'claude', workspaceRoot })).toMatchObject({
      kind: 'threads',
      result: { data: [{ nativeId }] },
    });
    const [pid] = await readPids(root);
    expect(await readPids(root)).toHaveLength(1);
    // the read process that checked the CLI closes after its idle period
    await expect.poll(() => countHeldDelays(300)).toBe(1);
    expect(releaseHeldDelays(300)).toBe(1);
    await expect.poll(() => isRunning(pid!)).toBe(false);
    for (const command of [
      { kind: 'threads', provider: 'claude', workspaceRoot },
      { kind: 'thread', provider: 'claude', workspaceRoot, nativeId },
      { kind: 'turns', provider: 'claude', workspaceRoot, nativeId },
      { kind: 'items', provider: 'claude', workspaceRoot, nativeId },
      { kind: 'session-evidence', provider: 'claude', workspaceRoot, nativeId },
    ] as const)
      expect(await request(command)).toMatchObject({ kind: command.kind });
    expect(await readPids(root)).toHaveLength(1);
    // a read that uses the native connection still opens it
    await request({ kind: 'models', provider: 'claude' });
    expect(await readPids(root)).toHaveLength(2);
  });
});
