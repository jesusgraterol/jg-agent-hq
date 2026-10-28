// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISessionTransition } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';

import {
  claudeRecord,
  countHeldDelays,
  releaseHeldDelays,
  startHoldingDelays,
  stopHoldingDelays,
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../../scripts/test-support/index.js';

// the pace test releases the waits between runs instead of waiting them out
vi.mock('jg-utilities', async (original) => {
  const actual = await original<typeof import('jg-utilities')>();
  const { holdDelays } = await import('../../../../scripts/test-support/delays.js');
  return { ...actual, delay: holdDelays(actual.delay) };
});

const transitions = async (fixture: IClaudeFixture): Promise<ISessionTransition[]> => {
  const response = await fixture.runtime.request({ kind: 'session-states', limit: 128 });
  if (response.kind !== 'session-states') throw new Error('Missing session states');
  return response.result.data;
};
const summary = (transition: ISessionTransition) => [
  transition.nativeId,
  transition.previousState,
  transition.state,
  transition.reason,
  transition.ownership,
];
const runs = async (fixture: IClaudeFixture): Promise<number> => {
  try {
    return (await readFile(join(fixture.root, 'claude-agents-runs.jsonl'), 'utf8'))
      .trim()
      .split('\n').length;
  } catch {
    return 0;
  }
};
// transitions one poll records together have no fixed order among themselves
const byNativeId = (left: unknown[], right: unknown[]) =>
  String(left[0]).localeCompare(String(right[0]));
const report = (fixture: IClaudeFixture, control: object) =>
  writeFixtureControl(fixture.root, 'claude-agents.json', control);
// these tests observe changes at the live pace, every 5 seconds
const live = (fixture: IClaudeFixture) =>
  fixture.runtime.request({ kind: 'observation-pace', pace: 'live' });

test(
  'claude agents report states by their fields, and a session that stops running disappears',
  // four five-second polls observe each change
  { timeout: 40_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      await live(fixture);
      const [busy, background, stopped] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [busy, background, stopped])
        await writeFile(
          fixture.transcript(id),
          `${JSON.stringify(claudeRecord(fixture.workspaceRoot, id))}\n`,
        );
      // what Claude Code 2.1.312 reports for a background session at each step
      const backgroundAgent = (fields: object) => ({
        id: 'background-1',
        pid: 3,
        cwd: fixture.workspaceRoot,
        kind: 'background',
        sessionId: background,
        name: 'background',
        ...fields,
      });
      // a background session that no longer runs keeps its last state but has no pid
      const stoppedAgent = {
        id: 'background-2',
        cwd: fixture.workspaceRoot,
        kind: 'background',
        sessionId: stopped,
        state: 'blocked',
      };
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: busy,
            name: 'terminal',
            status: 'busy',
          },
          backgroundAgent({ state: 'working' }),
          stoppedAgent,
          // outside the allowed workspaces, so never observed
          {
            pid: 2,
            cwd: fixture.root,
            kind: 'interactive',
            sessionId: randomUUID(),
            status: 'busy',
          },
        ],
      });
      await expect
        .poll(async () => (await transitions(fixture)).map(summary).sort(byNativeId), {
          timeout: 12_000,
        })
        .toStrictEqual(
          [
            [busy, null, 'running', 'turn-started', 'external'],
            [background, null, 'running', 'turn-started', 'external'],
          ].sort(byNativeId),
        );
      const listed = await fixture.runtime.request({
        kind: 'threads',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
      });
      if (listed.kind !== 'threads') throw new Error('Missing Claude sessions');
      expect(
        new Map(listed.result.data.map((thread) => [thread.nativeId, thread.state])),
      ).toStrictEqual(
        new Map([
          [busy, 'running'],
          [background, 'running'],
          [stopped, 'unknown'],
        ]),
      );
      // a question or a permission prompt reports waiting, for either kind of session
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: busy,
            status: 'waiting',
          },
          backgroundAgent({
            status: 'waiting',
            waitingFor: 'permission prompt',
            state: 'blocked',
          }),
          stoppedAgent,
        ],
      });
      await expect
        .poll(async () => (await transitions(fixture)).slice(2).map(summary).sort(byNativeId), {
          timeout: 12_000,
        })
        .toStrictEqual(
          [
            [busy, 'running', 'waiting', 'waiting-for-input', 'external'],
            [background, 'running', 'waiting', 'waiting-for-input', 'external'],
          ].sort(byNativeId),
        );
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: busy,
            status: 'idle',
          },
          backgroundAgent({ status: 'idle', state: 'done' }),
        ],
      });
      await expect
        .poll(async () => (await transitions(fixture)).slice(4).map(summary).sort(byNativeId), {
          timeout: 12_000,
        })
        .toStrictEqual(
          [
            [busy, 'waiting', 'idle', 'turn-completed', 'external'],
            [background, 'waiting', 'idle', 'turn-completed', 'external'],
          ].sort(byNativeId),
        );
      // stopping the background session leaves its entry without a pid
      await report(fixture, {
        agents: [{ ...backgroundAgent({ state: 'stopped' }), pid: undefined }],
      });
      await expect
        .poll(async () => (await transitions(fixture)).slice(6).map(summary).sort(byNativeId), {
          timeout: 12_000,
        })
        .toStrictEqual(
          [
            [busy, 'idle', 'closed', 'closed', 'external'],
            [background, 'idle', 'closed', 'closed', 'external'],
          ].sort(byNativeId),
        );
    });
  },
);

test(
  'claude agents entries for the processes this runtime started are left out, whatever session they name',
  // one five-second poll after the session is created
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      await live(fixture);
      const status = await fixture.runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime status');
      const created = await fixture.runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'claude',
            workspaceRoot: fixture.workspaceRoot,
            name: 'owned-process',
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      const threadId = created.result.threadId;
      await expect
        .poll(async () => {
          const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
          return thread.kind === 'managed-thread' ? thread.result?.state : null;
        })
        .toBe('idle');
      // the fake records the PID of each native process the runtime starts for a session
      const { pid } = JSON.parse(
        (await readFile(join(fixture.root, 'claude-pids.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .at(-1)!,
      ) as { pid: number };
      const external = randomUUID();
      await report(fixture, {
        agents: [
          {
            pid,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: randomUUID(),
            status: 'busy',
          },
          {
            pid: pid + 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: external,
            status: 'busy',
          },
        ],
      });
      await expect
        .poll(
          async () =>
            (await transitions(fixture))
              .filter((transition) => transition.ownership === 'external')
              .map(summary),
          { timeout: 12_000 },
        )
        .toStrictEqual([[external, null, 'running', 'turn-started', 'external']]);
    });
  },
);

test(
  'a late, oversized or malformed claude agents run changes nothing',
  // the late run holds its ten-second deadline, and the next run waits for a five-second tick
  { timeout: 90_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      await live(fixture);
      const id = randomUUID();
      const agent = {
        pid: 1,
        cwd: fixture.workspaceRoot,
        kind: 'interactive',
        sessionId: id,
        status: 'busy',
      };
      await report(fixture, { agents: [agent] });
      await expect
        .poll(async () => (await transitions(fixture)).map(summary), { timeout: 12_000 })
        .toStrictEqual([[id, null, 'running', 'turn-started', 'external']]);
      for (const control of [
        { delayMs: 11_000, agents: [] },
        { oversized: true },
        { malformed: true },
      ]) {
        await report(fixture, control);
        const before = await runs(fixture);
        // a later run proves the bad one ended without changing the recorded state
        await expect.poll(() => runs(fixture), { timeout: 30_000 }).toBeGreaterThan(before + 1);
        expect((await transitions(fixture)).map(summary)).toStrictEqual([
          [id, null, 'running', 'turn-started', 'external'],
        ]);
      }
      await report(fixture, { agents: [] });
      await expect
        .poll(async () => (await transitions(fixture)).slice(1).map(summary), { timeout: 12_000 })
        .toStrictEqual([[id, 'running', 'closed', 'disappeared', 'external']]);
    });
  },
);

test(
  'claude agents never report a session this runtime manages as external',
  // one five-second poll after the session is created
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      await live(fixture);
      const status = await fixture.runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime status');
      const created = await fixture.runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'claude',
            workspaceRoot: fixture.workspaceRoot,
            name: 'managed-claude',
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      const threadId = created.result.threadId;
      let nativeId: string | null = null;
      await expect
        .poll(async () => {
          const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
          nativeId = thread.kind === 'managed-thread' ? (thread.result?.nativeId ?? null) : null;
          return thread.kind === 'managed-thread' ? thread.result?.state : null;
        })
        .toBe('idle');
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: nativeId,
            status: 'busy',
          },
        ],
      });
      const before = await runs(fixture);
      await expect.poll(() => runs(fixture), { timeout: 12_000 }).toBeGreaterThan(before);
      expect(
        (await transitions(fixture)).map((transition) => [
          transition.threadId,
          transition.ownership,
          transition.state,
        ]),
      ).toStrictEqual([[threadId, 'managed', 'idle']]);
    });
  },
);

test('the active-sessions poll waits 30 seconds in the background and 5 while live, and a new pace runs at once', async () => {
  startHoldingDelays(5, 30);
  try {
    await withClaudeRuntime(async (fixture) => {
      // the runtime starts in the background pace after its first run
      await expect.poll(() => countHeldDelays(30)).toBe(1);
      expect(countHeldDelays(5)).toBe(0);
      const first = await runs(fixture);
      expect(
        await fixture.runtime.request({ kind: 'observation-pace', pace: 'live' }),
      ).toStrictEqual({ kind: 'observation-pace', result: { pace: 'live' } });
      await expect.poll(() => countHeldDelays(5)).toBe(1);
      expect(countHeldDelays(30)).toBe(0);
      expect(await runs(fixture)).toBe(first + 1);
      expect(releaseHeldDelays(5)).toBe(1);
      await expect.poll(() => runs(fixture)).toBe(first + 2);
      await expect.poll(() => countHeldDelays(5)).toBe(1);
      // the same pace again changes nothing
      await live(fixture);
      expect(countHeldDelays(5)).toBe(1);
      expect(await runs(fixture)).toBe(first + 2);
      await fixture.runtime.request({ kind: 'observation-pace', pace: 'background' });
      await expect.poll(() => countHeldDelays(30)).toBe(1);
      expect(countHeldDelays(5)).toBe(0);
      expect(await runs(fixture)).toBe(first + 3);
      expect(releaseHeldDelays(30)).toBe(1);
      await expect.poll(() => runs(fixture)).toBe(first + 4);
    });
  } finally {
    stopHoldingDelays();
  }
});
