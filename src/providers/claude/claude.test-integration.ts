// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HqResponseSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime } from '../../../scripts/test-support/index.js';

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
    expect(calls.map((call) => call.request.subtype)).toStrictEqual([
      'initialize',
      'get_usage',
      'get_usage',
    ]);
    expect(calls.slice(1).every((call) => call.request.skip_behaviors === true)).toBe(true);
  });
});

test('failed observations stay stale; account changes discard every prior-account window', async () => {
  await withClaudeRuntime(async ({ request, control }) => {
    const first = await request({ kind: 'usage', provider: 'claude' });
    expect(first.kind === 'usage' && first.result.state).toBe('available');
    await control({ failure: true });
    const stale = await request({ kind: 'usage', provider: 'claude' });
    expect(stale.kind === 'usage' && stale.result.state).toBe('stale');
    expect(
      stale.kind === 'usage' && stale.result.windows.map((window) => window.usedPercent),
    ).toStrictEqual([25, 60]);
    await control({ authChange: true });
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
    const fresh = await request({ kind: 'usage', provider: 'claude' });
    expect(
      fresh.kind === 'usage' && fresh.result.windows.map((window) => window.usedPercent),
    ).toStrictEqual([7]);
  });
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
