// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISessionTransition } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  claudeRecord,
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../../scripts/test-support/index.js';

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
const report = (fixture: IClaudeFixture, control: object) =>
  writeFixtureControl(fixture.root, 'claude-agents.json', control);

test(
  'claude agents report running, waiting and idle sessions, and a session that disappears',
  // four five-second polls observe each change
  { timeout: 40_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const [busy, blocked] = [randomUUID(), randomUUID()];
      for (const id of [busy, blocked])
        await writeFile(
          fixture.transcript(id),
          `${JSON.stringify(claudeRecord(fixture.workspaceRoot, id))}\n`,
        );
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
          {
            id: 'background-1',
            cwd: fixture.workspaceRoot,
            kind: 'background',
            sessionId: blocked,
            name: 'background',
            state: 'blocked',
          },
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
        .poll(async () => (await transitions(fixture)).map(summary), { timeout: 12_000 })
        .toStrictEqual([
          [busy, null, 'running', 'turn-started', 'external'],
          [blocked, null, 'waiting', 'waiting-for-input', 'external'],
        ]);
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
          [blocked, 'waiting'],
        ]),
      );
      // an interactive session reports a question or permission prompt as waiting
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: busy,
            status: 'waiting',
          },
          {
            id: 'background-1',
            cwd: fixture.workspaceRoot,
            kind: 'background',
            sessionId: blocked,
            state: 'blocked',
          },
        ],
      });
      await expect
        .poll(async () => (await transitions(fixture)).slice(2).map(summary), { timeout: 12_000 })
        .toStrictEqual([[busy, 'running', 'waiting', 'waiting-for-input', 'external']]);
      await report(fixture, {
        agents: [
          {
            pid: 1,
            cwd: fixture.workspaceRoot,
            kind: 'interactive',
            sessionId: busy,
            status: 'idle',
          },
        ],
      });
      await expect
        .poll(async () => (await transitions(fixture)).slice(3).map(summary), { timeout: 12_000 })
        .toStrictEqual([
          [busy, 'waiting', 'idle', 'turn-completed', 'external'],
          [blocked, 'waiting', 'closed', 'disappeared', 'external'],
        ]);
      await report(fixture, { agents: [] });
      await expect
        .poll(async () => (await transitions(fixture)).slice(5).map(summary), { timeout: 12_000 })
        .toStrictEqual([[busy, 'idle', 'closed', 'closed', 'external']]);
    });
  },
);

test(
  'a late, oversized or malformed claude agents run changes nothing',
  // the late run holds its ten-second deadline, and the next run waits for a five-second tick
  { timeout: 90_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
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
