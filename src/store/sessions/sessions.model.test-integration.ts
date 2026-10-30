// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq, type IAgentHq } from 'jg-agent-hq';
import type { ISessionTransition } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { withClaudeRuntime, type IClaudeFixture } from '../../../scripts/test-support/index.js';

const DAY_MS = 86_400_000;

const page = async (runtime: IAgentHq, afterSequence: number, limit: number) => {
  const response = await runtime.request({ kind: 'session-states', afterSequence, limit });
  if (response.kind !== 'session-states') throw new Error('Missing session states');
  return response.result;
};
const createThread = async (fixture: IClaudeFixture, runtime: IAgentHq, name: string) => {
  const status = await runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  const created = await runtime.request({
    kind: 'action',
    action: {
      id: randomUUID(),
      runtimeEpoch: status.result.runtimeEpoch,
      command: {
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        name,
      },
    },
  });
  if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
  const threadId = created.result.threadId;
  await expect
    .poll(async () => {
      const thread = await runtime.request({ kind: 'managed-thread', threadId });
      return thread.kind === 'managed-thread' ? thread.result?.state : null;
    })
    .toBe('idle');
  return threadId;
};

test('transitions are read in order from a cursor and survive a runtime restart', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threads = [
      await createThread(fixture, fixture.runtime, 'first-session'),
      await createThread(fixture, fixture.runtime, 'second-session'),
      await createThread(fixture, fixture.runtime, 'third-session'),
    ];
    const read: ISessionTransition[] = [];
    let afterSequence = 0;
    let hasMore = true;
    while (hasMore) {
      const result = await page(fixture.runtime, afterSequence, 1);
      expect(result.data).toHaveLength(1);
      read.push(...result.data);
      afterSequence = result.data[0]!.sequence;
      hasMore = result.hasMore;
    }
    expect(read.map((transition) => transition.threadId)).toStrictEqual(threads);
    expect(read.map((transition) => transition.sequence)).toStrictEqual(
      [...read.map((transition) => transition.sequence)].sort((left, right) => left - right),
    );
    expect(await page(fixture.runtime, afterSequence, 32)).toStrictEqual({
      data: [],
      hasMore: false,
      latestSequence: afterSequence,
      isReset: false,
    });
    await expect(page(fixture.runtime, 0, 129)).rejects.toMatchObject({
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
    });
    await fixture.runtime.close();
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      // closing the runtime closed each session after the transitions read before it
      const persisted = (await page(restarted, 0, 32)).data;
      expect(persisted.slice(0, read.length)).toStrictEqual(read);
      expect(
        persisted.slice(read.length).map((transition) => [transition.threadId, transition.state]),
      ).toStrictEqual(threads.map((threadId) => [threadId, 'closed']));
    } finally {
      await restarted.close();
    }
  });
});

test('transitions older than seven days are deleted in batches of 128 after each new one', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      const insert = database.prepare(
        "INSERT INTO hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at) VALUES ('codex', ?, NULL, 'external', NULL, 'idle', 'opened', ?)",
      );
      for (let index = 0; index < 130; index += 1)
        insert.run(`expired-${index}`, Date.now() - 8 * DAY_MS);
      // recent enough that its own insert prunes nothing
      insert.run('recent', Date.now() - 6 * DAY_MS);
    } finally {
      database.close();
    }
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      // each recorded transition deletes at most 128 expired rows
      await createThread(fixture, restarted, 'first-pruning');
      const first = (await page(restarted, 0, 128)).data.map((transition) => transition.nativeId);
      expect(first.filter((nativeId) => nativeId?.startsWith('expired-'))).toHaveLength(2);
      expect(first).toContain('recent');
      await createThread(fixture, restarted, 'second-pruning');
      const second = (await page(restarted, 0, 128)).data.map((transition) => transition.nativeId);
      expect(second.filter((nativeId) => nativeId?.startsWith('expired-'))).toStrictEqual([]);
      expect(second).toContain('recent');
    } finally {
      await restarted.close();
    }
  });
});

test('latestSequence follows the newest transition, and a cursor past it is reset', async () => {
  await withClaudeRuntime(async (fixture) => {
    expect(await page(fixture.runtime, 0, 32)).toStrictEqual({
      data: [],
      hasMore: false,
      latestSequence: 0,
      isReset: false,
    });
    // a cursor kept from another state root, as before a fresh runtime or a restore
    expect(await page(fixture.runtime, 3, 32)).toStrictEqual({
      data: [],
      hasMore: false,
      latestSequence: 0,
      isReset: true,
    });
    await createThread(fixture, fixture.runtime, 'first-position');
    await createThread(fixture, fixture.runtime, 'second-position');
    const [first, second] = (await page(fixture.runtime, 0, 32)).data;
    expect(await page(fixture.runtime, first!.sequence, 32)).toStrictEqual({
      data: [second],
      hasMore: false,
      latestSequence: second!.sequence,
      isReset: false,
    });
    expect(await page(fixture.runtime, second!.sequence + 1, 32)).toStrictEqual({
      data: [],
      hasMore: false,
      latestSequence: second!.sequence,
      isReset: true,
    });
  });
});

test('a cursor whose transition was pruned is reset, and latestSequence stays the highest ever issued', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.close();
    const databasePath = join(fixture.stateRoot, 'hq.sqlite');
    const seed = new DatabaseSync(databasePath);
    try {
      const insert = seed.prepare(
        "INSERT INTO hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at) VALUES ('codex', ?, NULL, 'external', NULL, 'idle', 'opened', ?)",
      );
      for (const nativeId of ['expired-first', 'expired-second'])
        insert.run(nativeId, Date.now() - 8 * DAY_MS);
    } finally {
      seed.close();
    }
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const [oldest, older] = (await page(restarted, 0, 32)).data;
      expect(await page(restarted, oldest!.sequence, 32)).toStrictEqual({
        data: [older],
        hasMore: false,
        latestSequence: older!.sequence,
        isReset: false,
      });
      // the new session's transition prunes both expired ones
      await createThread(fixture, restarted, 'after-pruning');
      const resumed = await page(restarted, oldest!.sequence, 32);
      expect(resumed.isReset).toBe(true);
      expect(resumed.data).toHaveLength(1);
      expect(resumed.data[0]!.sequence).toBeGreaterThan(older!.sequence);
      expect(resumed.latestSequence).toBe(resumed.data[0]!.sequence);
      expect((await page(restarted, resumed.latestSequence, 32)).isReset).toBe(false);
    } finally {
      await restarted.close();
    }
    // emptying the log stands in for every transition, including the newest, being pruned
    const emptied = new DatabaseSync(databasePath);
    let latest: number;
    try {
      latest = Number(
        emptied.prepare('SELECT max(sequence) AS latest FROM hq_session_transition').get()!.latest,
      );
      emptied.exec('DELETE FROM hq_session_transition');
    } finally {
      emptied.close();
    }
    const reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect(await page(reopened, 0, 32)).toStrictEqual({
        data: [],
        hasMore: false,
        latestSequence: latest,
        isReset: false,
      });
      expect((await page(reopened, latest, 32)).isReset).toBe(true);
    } finally {
      await reopened.close();
    }
  });
});
