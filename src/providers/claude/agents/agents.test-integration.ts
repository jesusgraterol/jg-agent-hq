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

// observer intervals are released by each test; native deadlines and process I/O stay real
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

/** Runs a real isolated runtime with test-controlled observer intervals. */
const withPollingRuntime = async (
  run: (fixture: IClaudeFixture) => Promise<void>,
): Promise<void> => {
  startHoldingDelays(5, 30);
  try {
    await withClaudeRuntime(run);
  } finally {
    stopHoldingDelays();
  }
  expect(countHeldDelays(5)).toBe(0);
  expect(countHeldDelays(30)).toBe(0);
};

/** Releases one observer interval and waits for the native run and its state writes to finish. */
const pollAgents = async (fixture: IClaudeFixture): Promise<void> => {
  await expect.poll(() => countHeldDelays(5), { timeout: 12_000 }).toBe(1);
  const before = await runs(fixture);
  expect(releaseHeldDelays(5)).toBe(1);
  // the late-output fixture must still reach its real ten-second native process deadline
  await expect.poll(() => countHeldDelays(5), { timeout: 12_000 }).toBe(1);
  expect(await runs(fixture)).toBe(before + 1);
};

// transitions one poll records together have no fixed order among themselves
const byNativeId = (left: unknown[], right: unknown[]) =>
  String(left[0]).localeCompare(String(right[0]));
const report = async (fixture: IClaudeFixture, control: object): Promise<void> => {
  await writeFixtureControl(fixture.root, 'claude-agents.json', control);
  await pollAgents(fixture);
};
// live pace requests five-second intervals; pollAgents releases each one
const live = (fixture: IClaudeFixture) =>
  fixture.runtime.request({ kind: 'observation-pace', pace: 'live' });

test(
  'claude agents report states by their fields, and a session that stops running disappears',
  // each recorded state change follows a separately released observer poll
  { timeout: 40_000 },
  async () => {
    await withPollingRuntime(async (fixture) => {
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
      // each running session names the terminal that runs it, with the ID `claude attach` takes
      expect(
        new Map(listed.result.data.map((thread) => [thread.nativeId, thread.terminal])),
      ).toStrictEqual(
        new Map([
          [busy, { kind: 'interactive' }],
          [background, { kind: 'background', attachId: 'background-1' }],
          [stopped, null],
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
  // one completed observer poll after the session is created
  { timeout: 20_000 },
  async () => {
    await withPollingRuntime(async (fixture) => {
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
  // late native runs retain their real ten-second deadline; only observer intervals are released
  { timeout: 90_000 },
  async () => {
    await withPollingRuntime(async (fixture) => {
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
        const before = await runs(fixture);
        await report(fixture, control);
        // two completed native attempts prove the bad response never changes recorded state
        await pollAgents(fixture);
        expect(await runs(fixture)).toBe(before + 2);
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
  // one completed observer poll after the session is created
  { timeout: 20_000 },
  async () => {
    await withPollingRuntime(async (fixture) => {
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
      const before = await runs(fixture);
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
      expect(await runs(fixture)).toBe(before + 1);
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

test(
  "a Claude session a terminal runs stays the terminal's: HQ neither adopts it nor sends a session it runs any input",
  // each change follows a separately released observer poll
  { timeout: 40_000 },
  async () => {
    await withPollingRuntime(async (fixture) => {
      await live(fixture);
      const submit = async (command: object) => {
        const status = await fixture.runtime.request({ kind: 'status' });
        if (status.kind !== 'status') throw new Error('Missing runtime status');
        return fixture.runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: command as never,
          },
        });
      };
      const terminal = randomUUID();
      await writeFile(
        fixture.transcript(terminal),
        `${JSON.stringify(claudeRecord(fixture.workspaceRoot, terminal))}\n`,
      );
      const listing = (sessionId: string) => ({
        pid: 7,
        cwd: fixture.workspaceRoot,
        kind: 'interactive',
        sessionId,
        status: 'idle',
      });
      await report(fixture, { agents: [listing(terminal)] });
      await expect
        .poll(async () => (await transitions(fixture)).map(summary), { timeout: 12_000 })
        .toStrictEqual([[terminal, null, 'idle', 'opened', 'external']]);
      const adoption = {
        kind: 'thread-adopt',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: terminal,
        name: 'from-terminal',
        operatorConfirmation: 'A message from the app',
      };
      await expect(submit(adoption)).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
      // once the terminal closes it, HQ takes it
      await report(fixture, { agents: [] });
      await expect
        .poll(async () => (await transitions(fixture)).slice(1).map(summary), { timeout: 12_000 })
        .toStrictEqual([[terminal, 'idle', 'closed', 'closed', 'external']]);
      expect(await submit(adoption)).toMatchObject({ kind: 'action' });
      // a session HQ started that a terminal then resumes takes no input from HQ
      const created = await submit({
        kind: 'thread-create',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        name: 'resumed-in-terminal',
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      const threadId = created.result.threadId;
      let nativeId = '';
      await expect
        .poll(async () => {
          const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
          nativeId = thread.kind === 'managed-thread' ? (thread.result?.nativeId ?? '') : '';
          return thread.kind === 'managed-thread' ? thread.result?.state : null;
        })
        .toBe('idle');
      const processes = async () =>
        (await readFile(join(fixture.root, 'claude-pids.jsonl'), 'utf8')).trim().split('\n').length;
      const before = await processes();
      await report(fixture, { agents: [listing(nativeId)] });
      // a poll's run is logged before HQ reads its output, so this waits for HQ to show the terminal
      await expect
        .poll(
          async () => {
            const session = await fixture.runtime.request({
              kind: 'thread',
              provider: 'claude',
              workspaceRoot: fixture.workspaceRoot,
              nativeId,
            });
            return session.kind === 'thread' ? session.result.terminal : null;
          },
          { timeout: 12_000 },
        )
        .toStrictEqual({ kind: 'interactive' });
      await expect(
        submit({ kind: 'message', threadId, input: { kind: 'text', text: 'From the app' } }),
      ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
      expect(await processes()).toBe(before);
    });
  },
);
