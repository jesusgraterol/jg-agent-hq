// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IActionCommand, IActionReceipt, ISessionTransition } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

const EXTERNAL = 'thread-1023';

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
const codex = (fixture: IClaudeFixture, settings: object) =>
  writeFixtureControl(fixture.root, 'control.json', settings);
const statusChanged = (status: object) => ({
  method: 'thread/status/changed',
  params: { threadId: EXTERNAL, status },
});
// the daemon broadcasts a status change; any request delivers the emitted notification
const broadcast = async (fixture: IClaudeFixture, status: object, settings: object = {}) => {
  await codex(fixture, {
    ...settings,
    threadStatuses: { [EXTERNAL]: status },
    emitOnce: true,
    emit: [statusChanged(status)],
  });
  await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
};
const calls = async (fixture: IClaudeFixture): Promise<{ method: string; params: unknown }[]> =>
  (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const submit = async (
  fixture: IClaudeFixture,
  command: IActionCommand,
): Promise<IActionReceipt> => {
  const status = await fixture.runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  const response = await fixture.runtime.request({
    kind: 'action',
    action: { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command },
  });
  if (response.kind !== 'action') throw new Error('Missing admission');
  return response.result;
};
const receipt = async (fixture: IClaudeFixture, actionId: string) => {
  const response = await fixture.runtime.request({ kind: 'receipt', actionId });
  return response.kind === 'receipt' ? response.result : null;
};
const thread = async (fixture: IClaudeFixture, threadId: string) => {
  const response = await fixture.runtime.request({ kind: 'managed-thread', threadId });
  return response.kind === 'managed-thread' ? response.result : null;
};
const createThread = async (fixture: IClaudeFixture, name: string) => {
  const created = await submit(fixture, {
    kind: 'thread-create',
    provider: 'codex',
    workspaceRoot: fixture.workspaceRoot,
    name,
  });
  await expect.poll(async () => (await thread(fixture, created.threadId!))?.state).toBe('idle');
  return (await thread(fixture, created.threadId!))!;
};

test('a session another Codex client drives stays external, and HQ adopts it between turns without changing its settings', async () => {
  await withClaudeRuntime(async (fixture) => {
    await codex(fixture, { threadStatuses: { [EXTERNAL]: { type: 'active', activeFlags: [] } } });
    const listed = await fixture.runtime.request({
      kind: 'threads',
      providers: ['codex'],
      workspaceRoots: [fixture.workspaceRoot],
      limit: 1,
    });
    if (listed.kind !== 'threads') throw new Error('Missing sessions');
    expect(listed.result.data[0]).toMatchObject({
      nativeId: EXTERNAL,
      nativeState: 'active',
      state: 'running',
      ownership: 'external',
      managedId: null,
    });
    // its items are readable without taking control of it
    expect(
      await fixture.runtime.request({
        kind: 'items',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: EXTERNAL,
        limit: 8,
      }),
    ).toMatchObject({
      kind: 'items',
      result: { data: [{ text: 'Hello from the native history' }] },
    });
    const adoption = {
      kind: 'thread-adopt' as const,
      provider: 'codex' as const,
      workspaceRoot: fixture.workspaceRoot,
      nativeId: EXTERNAL,
      name: 'adopted',
      operatorConfirmation: 'A message from the app',
    };
    // Codex runs one turn at a time, so a session mid-turn waits for the turn to end
    await expect(submit(fixture, adoption)).rejects.toMatchObject({
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    });
    await broadcast(fixture, { type: 'active', activeFlags: ['waitingOnApproval'] });
    await broadcast(fixture, { type: 'idle' });
    await expect
      .poll(async () => (await transitions(fixture)).map(summary))
      .toStrictEqual([
        [EXTERNAL, null, 'waiting', 'waiting-for-input', 'external'],
        [EXTERNAL, 'waiting', 'idle', 'turn-completed', 'external'],
      ]);
    expect((await calls(fixture)).some((call) => call.method === 'turn/start')).toBe(false);
    // between turns, still open in the terminal, HQ joins it without changing its settings
    const adopted = await submit(fixture, adoption);
    await expect
      .poll(async () => (await receipt(fixture, adopted.id))?.delivery)
      .toBe('acknowledged');
    expect(
      (await calls(fixture))
        .filter((call) => call.method === 'thread/resume')
        .map((call) => call.params),
    ).toStrictEqual([{ threadId: EXTERNAL, excludeTurns: true }]);
    const message = await submit(fixture, {
      kind: 'message',
      threadId: adopted.threadId!,
      input: { kind: 'text', text: 'Continue from the terminal session' },
    });
    await expect
      .poll(async () => (await receipt(fixture, message.id))?.completion)
      .toBe('completed');
    expect(
      (await calls(fixture)).filter(
        (call) =>
          call.method === 'turn/start' &&
          (call.params as { threadId: string }).threadId === EXTERNAL,
      ),
    ).toHaveLength(1);
  });
});

test.each(['fix-assurance', null])(
  'a terminal Codex rename to %s refreshes active metadata without changing activity',
  async (name) => {
    await withClaudeRuntime(async (fixture) => {
      const running = { type: 'active', activeFlags: [] };
      const active = async () => {
        const response = await fixture.runtime.request({ kind: 'active-sessions' });
        if (response.kind !== 'active-sessions') throw new Error('Missing active sessions');
        return response.result.data.find((session) => session.nativeId === EXTERNAL);
      };
      await broadcast(fixture, running);
      await expect.poll(active).toMatchObject({ name: 'Task 1023', state: 'running' });
      const before = (await active())!;
      const priorTransitions = await transitions(fixture);
      await codex(fixture, {
        threadNames: { [EXTERNAL]: name },
        threadStatuses: { [EXTERNAL]: running },
        emitOnce: true,
        emit: [
          {
            method: 'thread/name/updated',
            params: { threadId: EXTERNAL, ...(name === null ? {} : { threadName: name }) },
          },
        ],
      });
      await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(active)
        .toMatchObject({ name, state: 'running', updatedAt: before.updatedAt });
      expect(await transitions(fixture)).toStrictEqual(priorTransitions);
      const reads = (await calls(fixture)).filter((call) => call.method === 'thread/read').length;
      // a later status uses the refreshed cache, and the active read itself makes no native calls
      await broadcast(
        fixture,
        { type: 'active', activeFlags: ['waitingOnApproval'] },
        {
          threadNames: { [EXTERNAL]: name },
        },
      );
      await expect.poll(active).toMatchObject({ name, state: 'waiting' });
      expect((await calls(fixture)).filter((call) => call.method === 'thread/read')).toHaveLength(
        reads,
      );
    });
  },
);

test('a Codex session outside the allowed workspaces is never observed', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await broadcast(fixture, { type: 'active', activeFlags: [] }, { wrongRoot: fixture.root });
    await broadcast(fixture, { type: 'idle' }, { wrongRoot: fixture.root });
    // the session's workspace is read on its first change, so a later change shows the order held
    await codex(fixture, {});
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    expect(
      (await calls(fixture)).filter((call) => call.method === 'thread/read').length,
    ).toBeGreaterThan(0);
    expect(await transitions(fixture)).toStrictEqual([]);
  });
});

test('a Codex session Codex never saves, such as its own helper sessions, is never observed', async () => {
  await withClaudeRuntime(async (fixture) => {
    const saved = 'thread-1022';
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await codex(fixture, {
      ephemeralThreads: [EXTERNAL],
      threadStatuses: { [EXTERNAL]: { type: 'active', activeFlags: [] } },
      emitOnce: true,
      emit: [
        statusChanged({ type: 'active', activeFlags: [] }),
        { method: 'thread/status/changed', params: { threadId: saved, status: { type: 'idle' } } },
      ],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    // sessions are observed in order, so the saved session's change shows the other one was read
    await expect
      .poll(async () => (await transitions(fixture)).map(summary))
      .toStrictEqual([[saved, null, 'idle', 'opened', 'external']]);
  });
});

test('interrupt and close of a Codex session count only once the daemon confirms them', async () => {
  await withClaudeRuntime(async (fixture) => {
    const managed = await createThread(fixture, 'confirmed-controls');
    await codex(fixture, { holdTurn: true, holdInterrupt: true });
    await submit(fixture, {
      kind: 'message',
      threadId: managed.id,
      input: { kind: 'text', text: 'Run until interrupted' },
    });
    await expect.poll(async () => (await thread(fixture, managed.id))?.state).toBe('running');
    const running = (await thread(fixture, managed.id))!;
    const interrupt = await submit(fixture, {
      kind: 'interrupt',
      threadId: managed.id,
      expectedTurnId: running.activeTurnId!,
    });
    await expect
      .poll(async () => (await calls(fixture)).some((call) => call.method === 'turn/interrupt'))
      .toBe(true);
    expect(await receipt(fixture, interrupt.id)).toMatchObject({ delivery: 'submitted' });
    expect((await thread(fixture, managed.id))?.state).toBe('stopping');
    expect(
      (await transitions(fixture)).some((transition) => transition.reason === 'operator-stopped'),
    ).toBe(false);
    await codex(fixture, { holdTurn: true, releaseInterrupts: true });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect.poll(async () => (await thread(fixture, managed.id))?.state).toBe('interrupted');
    expect(await receipt(fixture, interrupt.id)).toMatchObject({ delivery: 'acknowledged' });
    const close = await submit(fixture, { kind: 'thread-close', threadId: managed.id });
    await expect
      .poll(async () => (await receipt(fixture, close.id))?.delivery)
      .toBe('acknowledged');
    expect(
      (await transitions(fixture)).map((transition) => [
        transition.threadId,
        transition.previousState,
        transition.state,
        transition.reason,
      ]),
    ).toStrictEqual([
      [managed.id, null, 'idle', 'opened'],
      [managed.id, 'idle', 'running', 'turn-started'],
      [managed.id, 'running', 'idle', 'operator-stopped'],
      [managed.id, 'idle', 'closed', 'closed'],
    ]);
  });
});

test('a Codex daemon restart leaves sessions uncertain, resends nothing and reconnects on the next read', async () => {
  await withClaudeRuntime(async (fixture) => {
    const managed = await createThread(fixture, 'daemon-restart');
    await codex(fixture, { holdTurn: true });
    await submit(fixture, {
      kind: 'message',
      threadId: managed.id,
      input: { kind: 'text', text: 'Keep working' },
    });
    await expect.poll(async () => (await thread(fixture, managed.id))?.state).toBe('running');
    await broadcast(fixture, { type: 'idle' }, { holdTurn: true });
    await expect.poll(async () => (await transitions(fixture)).length).toBe(3);
    await codex(fixture, { mode: 'exit-on-list' });
    expect(
      await fixture.runtime.request({
        kind: 'threads',
        providers: ['codex'],
        workspaceRoots: [fixture.workspaceRoot],
      }),
    ).toMatchObject({ result: { unavailable: [{ provider: 'codex' }] } });
    await expect.poll(async () => (await thread(fixture, managed.id))?.ownership).toBe('uncertain');
    await expect
      .poll(async () => (await transitions(fixture)).slice(3).map(summary))
      .toStrictEqual(
        expect.arrayContaining([
          [managed.nativeId, 'running', 'unknown', 'disappeared', 'uncertain'],
          [EXTERNAL, 'idle', 'unknown', 'disappeared', 'external'],
        ]),
      );
    await codex(fixture, {});
    expect(
      await fixture.runtime.request({
        kind: 'threads',
        providers: ['codex'],
        workspaceRoots: [fixture.workspaceRoot],
        limit: 1,
      }),
    ).toMatchObject({ kind: 'threads' });
    const proxies = (await readFile(join(fixture.root, 'commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line === JSON.stringify(['app-server', 'proxy']));
    expect(proxies.length).toBeGreaterThanOrEqual(2);
    expect((await calls(fixture)).filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});

test('a Codex session whose status this package does not know is listed and read as unknown', async () => {
  await withClaudeRuntime(async (fixture) => {
    await codex(fixture, { threadStatuses: { 'thread-1023': { type: 'hibernating' } } });
    expect(
      await fixture.runtime.request({
        kind: 'threads',
        providers: ['codex'],
        workspaceRoots: [fixture.workspaceRoot],
        limit: 1,
      }),
    ).toMatchObject({ result: { data: [{ nativeId: 'thread-1023', state: 'unknown' }] } });
    expect(
      await fixture.runtime.request({
        kind: 'thread',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: 'thread-1023',
      }),
    ).toMatchObject({ result: { nativeId: 'thread-1023', state: 'unknown' } });
  });
});

test('the daemon loaded threads record their states on every connect, skipping ephemeral ones', async () => {
  await withClaudeRuntime(async (fixture) => {
    const running = { type: 'active', activeFlags: [] };
    // a terminal session running before HQ connects reports no status change of its own
    await codex(fixture, {
      loadedThreads: [EXTERNAL, 'thread-1022'],
      threadStatuses: { [EXTERNAL]: running, 'thread-1022': running },
      ephemeralThreads: ['thread-1022'],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () => (await transitions(fixture)).map(summary))
      .toStrictEqual([[EXTERNAL, null, 'running', 'turn-started', 'external']]);
    // the turn ends while the daemon restarts, and the reconnect reads the loaded threads again
    await codex(fixture, { mode: 'exit-on-list' });
    expect(
      await fixture.runtime.request({
        kind: 'threads',
        providers: ['codex'],
        workspaceRoots: [fixture.workspaceRoot],
      }),
    ).toMatchObject({ result: { unavailable: [{ provider: 'codex' }] } });
    await codex(fixture, {
      loadedThreads: [EXTERNAL],
      threadStatuses: { [EXTERNAL]: { type: 'idle' } },
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(
        async () =>
          (await transitions(fixture)).at(-1) && summary((await transitions(fixture)).at(-1)!),
      )
      .toStrictEqual(expect.arrayContaining([EXTERNAL, 'idle', 'external']));
    expect(
      (await transitions(fixture)).some((transition) => transition.nativeId === 'thread-1022'),
    ).toBe(false);
  });
});

test('Codex threads are listed by last activity', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.request({
      kind: 'threads',
      providers: ['codex'],
      workspaceRoots: [fixture.workspaceRoot],
      limit: 1,
    });
    expect(
      (await calls(fixture))
        .filter((call) => call.method === 'thread/list')
        .map((call) => call.params as { sortKey: string; sortDirection: string }),
    ).toStrictEqual([expect.objectContaining({ sortKey: 'updated_at', sortDirection: 'desc' })]);
  });
});

test(
  'threads lists the sessions HQ created that no turn has started by their last update, which read without native history',
  // the test starts, runs and closes several sessions through the fake daemon
  { timeout: 30_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const listed = async (cursor?: string) => {
        const response = await fixture.runtime.request({
          kind: 'threads',
          providers: ['codex'],
          workspaceRoots: [fixture.workspaceRoot],
          ...(cursor ? { cursor } : {}),
        });
        if (response.kind !== 'threads') throw new Error('Missing sessions');
        return response.result;
      };
      const fresh = await createThread(fixture, 'fresh');
      const worked = await createThread(fixture, 'worked');
      await submit(fixture, {
        kind: 'message',
        threadId: worked.id,
        input: { kind: 'text', text: 'Start' },
      });
      await expect.poll(async () => (await thread(fixture, worked.id))?.state).toBe('completed');
      const closed = await createThread(fixture, 'closed');
      await submit(fixture, { kind: 'thread-close', threadId: closed.id });
      await expect.poll(async () => (await thread(fixture, closed.id))?.state).toBe('inactive');
      // updated after every native session, it comes first, and the started and closed ones don't show
      const first = await listed();
      expect(first.data[0]).toStrictEqual(
        expect.objectContaining({
          provider: 'codex',
          nativeId: fresh.nativeId,
          name: 'fresh',
          workspaceRoot: fixture.workspaceRoot,
          updatedAt: fresh.updatedAt,
          state: 'idle',
          ownership: 'managed',
          managedId: fresh.id,
          historyState: 'available',
        }),
      );
      expect(first.data.slice(1).map((session) => session.nativeId)).toStrictEqual(
        Array.from({ length: 31 }, (_, index) => `thread-${String(1023 - index).padStart(4, '0')}`),
      );
      // its own reads answer from the record instead of native history
      const target = {
        provider: 'codex' as const,
        workspaceRoot: fixture.workspaceRoot,
        nativeId: fresh.nativeId!,
      };
      expect(await fixture.runtime.request({ kind: 'thread', ...target })).toMatchObject({
        kind: 'thread',
        result: { nativeId: fresh.nativeId, managedId: fresh.id, state: 'idle' },
      });
      expect(await fixture.runtime.request({ kind: 'items', ...target })).toMatchObject({
        kind: 'items',
        result: { data: [], nextCursor: null },
      });
      expect(
        (await calls(fixture)).some(
          (call) =>
            call.method === 'thread/items/list' &&
            (call.params as { threadId: string }).threadId === fresh.nativeId,
        ),
      ).toBe(false);
      // at most 32 sessions are open at once, so newer unstarted records are written directly
      const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { timeout: 5_000 });
      try {
        const insert = database.prepare(
          `INSERT INTO agent_hq_thread (id, provider, native_id, name, workspace_root, ownership, state,
          registration_action_id, created_at, updated_at)
          SELECT ?, provider, ?, ?, workspace_root, ownership, state, registration_action_id, ?, ?
          FROM agent_hq_thread WHERE id = ?`,
        );
        for (let index = 0; index < 32; index += 1)
          insert.run(
            randomUUID(),
            `native-more-${index}`,
            `more-${index}`,
            Date.now() + index,
            Date.now() + index,
            fresh.id,
          );
        // a session whose creation Codex never acknowledged has no native ID yet
        database
          .prepare(
            `INSERT INTO agent_hq_thread (id, provider, native_id, name, workspace_root, ownership, state,
            registration_action_id, created_at, updated_at)
            SELECT ?, provider, NULL, 'unacknowledged', workspace_root, ownership, 'creating',
            registration_action_id, ?, ? FROM agent_hq_thread WHERE id = ?`,
          )
          .run(randomUUID(), Date.now() + 64, Date.now() + 64, fresh.id);
      } finally {
        database.close();
      }
      // newest first across pages, and the unacknowledged one isn't listed
      const cut = await listed();
      expect(cut.data.map((session) => session.name)).toStrictEqual(
        Array.from({ length: 32 }, (_, index) => `more-${31 - index}`),
      );
      const next = await listed(cut.nextCursor!);
      expect(next.data[0]).toMatchObject({ nativeId: fresh.nativeId, managedId: fresh.id });
      expect(next.data[1]).toMatchObject({ nativeId: 'thread-1023', managedId: null });
    });
  },
);

test('a Codex session HQ closed shows the terminal that continues it, and resumes while the terminal has it loaded', async () => {
  await withClaudeRuntime(async (fixture) => {
    const managed = await createThread(fixture, 'closed-here');
    const nativeId = managed.nativeId!;
    // the terminal keeps the thread loaded after HQ releases it
    await codex(fixture, { unsubscribeState: 'idle' });
    await submit(fixture, { kind: 'thread-close', threadId: managed.id });
    await expect.poll(async () => (await thread(fixture, managed.id))?.state).toBe('inactive');
    const running = { type: 'active', activeFlags: [] };
    await codex(fixture, {
      threadStatuses: { [nativeId]: running },
      emitOnce: true,
      emit: [{ method: 'thread/status/changed', params: { threadId: nativeId, status: running } }],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () =>
        (await transitions(fixture))
          .filter((transition) => transition.ownership === 'external')
          .map(summary),
      )
      .toStrictEqual([[nativeId, null, 'running', 'turn-started', 'external']]);
    expect(
      await fixture.runtime.request({
        kind: 'thread',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        nativeId,
      }),
    ).toMatchObject({ kind: 'thread', result: { state: 'running', managedId: managed.id } });
    // once the terminal's turn ends, HQ resumes the session it still has loaded
    await codex(fixture, { threadStatuses: { [nativeId]: { type: 'idle' } } });
    const resumed = await submit(fixture, {
      kind: 'thread-resume',
      threadId: managed.id,
      operatorConfirmation: 'A message from the app',
    });
    await expect
      .poll(async () => (await receipt(fixture, resumed.id))?.delivery)
      .toBe('acknowledged');
    expect((await thread(fixture, managed.id))?.state).toBe('idle');
    expect(
      (await calls(fixture))
        .filter((call) => call.method === 'thread/resume')
        .map((call) => call.params),
    ).toStrictEqual([{ threadId: nativeId, excludeTurns: true }]);
  });
});

test('an approval the terminal answers first settles the prompt HQ holds', async () => {
  await withClaudeRuntime(async (fixture) => {
    const managed = await createThread(fixture, 'shared-approval');
    await codex(fixture, {
      prompt: {
        method: 'item/commandExecution/requestApproval',
        params: {
          startedAtMs: Date.now(),
          command: 'curl -sI https://example.com',
          cwd: fixture.workspaceRoot,
          availableDecisions: ['accept', 'cancel'],
        },
      },
    });
    await submit(fixture, {
      kind: 'message',
      threadId: managed.id,
      input: { kind: 'text', text: 'Fetch the page' },
    });
    await expect
      .poll(async () => (await thread(fixture, managed.id))?.state)
      .toBe('waiting-approval');
    const approvals = async () => {
      const response = await fixture.runtime.request({ kind: 'approvals', threadId: managed.id });
      if (response.kind !== 'approvals') throw new Error('Missing approvals');
      return response.result.data;
    };
    expect((await approvals()).map((approval) => approval.state)).toStrictEqual(['pending']);
    // the daemon resolves the request that the terminal answered and HQ never did
    await codex(fixture, {
      holdTurn: true,
      emitOnce: true,
      emit: [
        {
          method: 'serverRequest/resolved',
          params: { threadId: managed.nativeId, requestId: 'native-approval-1' },
        },
      ],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () => (await approvals()).map((approval) => approval.state))
      .toStrictEqual(['expired']);
    // HQ never answered the request itself
    await expect(readFile(join(fixture.root, 'replies.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

test('a Codex notification that fails validation never closes the shared connection', async () => {
  await withClaudeRuntime(async (fixture) => {
    // a status newer than this package knows makes another client's session unknown
    await broadcast(fixture, { type: 'active', activeFlags: [] });
    await codex(fixture, { emitOnce: true, emit: [statusChanged({ type: 'hibernating' })] });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () => (await transitions(fixture)).map((transition) => transition.state))
      .toStrictEqual(['running', 'unknown']);
    const managed = await createThread(fixture, 'tolerant-session');
    await codex(fixture, { holdTurn: true });
    await submit(fixture, {
      kind: 'message',
      threadId: managed.id,
      input: { kind: 'text', text: 'Keep going' },
    });
    await expect.poll(async () => (await thread(fixture, managed.id))?.state).toBe('running');
    const turnId = (await thread(fixture, managed.id))!.activeTurnId!;
    // an item and a token count that fail validation only mark the live window's gap
    await codex(fixture, {
      holdTurn: true,
      emitOnce: true,
      emit: [
        {
          method: 'item/completed',
          params: {
            threadId: managed.nativeId,
            turnId,
            item: { id: 'broken-item', type: 'commandExecution', command: 42 },
          },
        },
        {
          method: 'thread/tokenUsage/updated',
          params: { threadId: managed.nativeId, turnId, tokenUsage: 'unexpected' },
        },
      ],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () => {
        const live = await fixture.runtime.request({ kind: 'live-items', threadId: managed.id });
        return live.kind === 'live-items' && live.result.hasGap;
      })
      .toBe(true);
    expect(await thread(fixture, managed.id)).toMatchObject({
      state: 'running',
      ownership: 'managed',
    });
    // a message that is neither a request, a notification nor a response still fails it
    await codex(fixture, { holdTurn: true, emitOnce: true, emitRequests: [{ result: {} }] });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' }).catch(() => undefined);
    await expect.poll(async () => (await thread(fixture, managed.id))?.ownership).toBe('uncertain');
  });
});
