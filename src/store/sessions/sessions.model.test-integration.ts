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
