// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import type { IAgentHq } from 'jg-agent-hq';
import type { IActionCommand } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

// submits one action to the fixture's runtime
const submit = (runtime: IAgentHq, command: IActionCommand) =>
  runtime.request({
    kind: 'action',
    action: { id: randomUUID(), runtimeEpoch: runtime.runtimeEpoch, command },
  });

// creates a Codex session and waits until it is idle
const createSession = async (fixture: IClaudeFixture, name: string): Promise<string> => {
  const created = await submit(fixture.runtime, {
    kind: 'thread-create',
    provider: 'codex',
    workspaceRoot: fixture.workspaceRoot,
    name,
  });
  const threadId = created.result.threadId!;
  await expect
    .poll(async () => (await fixture.runtime.request({ kind: 'managed-thread', threadId })).result)
    .toMatchObject({ state: 'idle' });
  return threadId;
};

// the newest transition sequence, after which a reader follows only new transitions
const latestSequence = async (runtime: IAgentHq): Promise<number> =>
  (await runtime.request({ kind: 'session-states', limit: 1 })).result.latestSequence;

// tracks whether a request has settled, to show it still waits
const track = <T>(promise: Promise<T>) => {
  const state = { isSettled: false };
  void promise.then(
    () => {
      state.isSettled = true;
    },
    () => {
      state.isSettled = true;
    },
  );
  return state;
};

test('a session-states long-poll answers at once with transitions after its sequence, each with its folder', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await createSession(fixture, 'existing-change');
    const page = await fixture.runtime.request({
      kind: 'session-states',
      afterSequence: 0,
      waitMs: 30_000,
    });
    expect(page.result.data.length).toBeGreaterThan(0);
    expect(page.result.data.filter((transition) => transition.threadId === threadId)).toEqual([
      expect.objectContaining({
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        state: 'idle',
        reason: 'opened',
      }),
    ]);
  });
});

test('a session-states long-poll over IPC waits for the next transition and returns it', async () => {
  await withClaudeRuntime(async (fixture) => {
    const after = await latestSequence(fixture.runtime);
    const waiting = fixture.request({
      kind: 'session-states',
      afterSequence: after,
      waitMs: 30_000,
    });
    const progress = track(waiting);
    // a round trip through the runtime, after which the long-poll still has nothing to answer
    await fixture.runtime.request({ kind: 'status' });
    expect(progress.isSettled).toBe(false);
    const threadId = await createSession(fixture, 'next-change');
    const page = (await waiting).result;
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]).toMatchObject({
      sequence: after + 1,
      threadId,
      workspaceRoot: fixture.workspaceRoot,
    });
  });
});

test('a session-states long-poll answers with an empty page once its wait passes', async () => {
  await withClaudeRuntime(async (fixture) => {
    await createSession(fixture, 'quiet-session');
    const after = await latestSequence(fixture.runtime);
    const startedAt = performance.now();
    const page = await fixture.runtime.request({
      kind: 'session-states',
      afterSequence: after,
      waitMs: 200,
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(page.result).toStrictEqual({
      data: [],
      hasMore: false,
      latestSequence: after,
      isReset: false,
    });
  });
});

test("a session-states long-poll answers at once when its cursor can't continue", async () => {
  await withClaudeRuntime(async (fixture) => {
    const page = await fixture.runtime.request({
      kind: 'session-states',
      afterSequence: (await latestSequence(fixture.runtime)) + 1_000,
      waitMs: 30_000,
    });
    expect(page.result).toMatchObject({ data: [], isReset: true });
  });
});

test('a live-items long-poll answers a changed window at once, waits for the next change and cuts its text', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await createSession(fixture, 'live-session');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await submit(fixture.runtime, {
      kind: 'message',
      threadId,
      input: { kind: 'text', text: 'Stream something' },
    });
    // the window changed after revision 0, so the long-poll answers at once
    const first = (
      await fixture.runtime.request({
        kind: 'live-items',
        threadId,
        afterRevision: 0,
        waitMs: 30_000,
      })
    ).result;
    expect(first.unchanged).toBe(false);
    const thread = (await fixture.runtime.request({ kind: 'managed-thread', threadId })).result!;
    await expect
      .poll(async () => (await fixture.runtime.request({ kind: 'live-items', threadId })).result)
      .toMatchObject({ data: [{ text: 'Live response', state: 'active' }] });
    const current = (await fixture.runtime.request({ kind: 'live-items', threadId })).result;
    const item = current.data[0]!;
    // the next Codex request makes the fixture stream more text into the running item
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      emitOnce: true,
      emit: [
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: thread.nativeId,
            turnId: item.turnId,
            itemId: item.nativeId,
            delta: ' and more',
          },
        },
      ],
    });
    const waiting = fixture.runtime.request({
      kind: 'live-items',
      threadId,
      afterRevision: current.revision,
      waitMs: 30_000,
      textLimit: 4,
    });
    const progress = track(waiting);
    await fixture.runtime.request({ kind: 'status' });
    expect(progress.isSettled).toBe(false);
    await fixture.runtime.request({ kind: 'models', provider: 'codex' });
    const changed = (await waiting).result;
    expect(changed.unchanged).toBe(false);
    expect(changed.revision).toBeGreaterThan(current.revision);
    expect(changed.data).toEqual([
      expect.objectContaining({ text: 'Live', isTruncated: true, state: 'active' }),
    ]);
    expect(
      (await fixture.runtime.request({ kind: 'live-items', threadId })).result.data[0]?.text,
    ).toBe('Live response and more');
  });
});

test('a live-items long-poll answers unchanged with no items once its wait passes', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await createSession(fixture, 'still-session');
    const current = (await fixture.runtime.request({ kind: 'live-items', threadId })).result;
    const startedAt = performance.now();
    const window = await fixture.runtime.request({
      kind: 'live-items',
      threadId,
      afterRevision: current.revision,
      waitMs: 200,
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(window.result).toMatchObject({ revision: current.revision, unchanged: true, data: [] });
  });
});

test('waiting long-polls end with RUNTIME_NOT_RUNNING as the runtime closes', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await createSession(fixture, 'closing-session');
    const current = (await fixture.runtime.request({ kind: 'live-items', threadId })).result;
    const transitions = fixture.runtime.request({
      kind: 'session-states',
      afterSequence: await latestSequence(fixture.runtime),
      waitMs: 30_000,
    });
    const live = fixture.runtime.request({
      kind: 'live-items',
      threadId,
      afterRevision: current.revision,
      waitMs: 30_000,
    });
    const progress = [track(transitions), track(live)];
    const ended = Promise.all([
      expectToRejectCode(transitions, 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING'),
      expectToRejectCode(live, 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING'),
    ]);
    // the store answers in order, so both long-polls wait once a later store read answers
    await fixture.runtime.request({ kind: 'session-states', limit: 1 });
    expect(progress.map(({ isSettled }) => isSettled)).toStrictEqual([false, false]);
    await fixture.runtime.close();
    await ended;
  });
});

test('at most 32 long-polls wait at once, and each one that ends frees its place', async () => {
  await withClaudeRuntime(async (fixture) => {
    const after = await latestSequence(fixture.runtime);
    const waiting = Array.from({ length: 32 }, () =>
      fixture.runtime.request({ kind: 'session-states', afterSequence: after, waitMs: 30_000 }),
    );
    await fixture.runtime.request({ kind: 'status' });
    await expectToRejectCode(
      fixture.runtime.request({ kind: 'session-states', afterSequence: after, waitMs: 30_000 }),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    const threadId = await createSession(fixture, 'many-waits');
    for (const page of await Promise.all(waiting))
      expect(page.result.data[0]).toMatchObject({ sequence: after + 1, threadId });
    expect(
      (
        await fixture.runtime.request({
          kind: 'session-states',
          afterSequence: await latestSequence(fixture.runtime),
          waitMs: 50,
        })
      ).result.data,
    ).toStrictEqual([]);
  });
});
