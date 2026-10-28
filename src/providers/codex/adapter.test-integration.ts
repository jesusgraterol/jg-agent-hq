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
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
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
      provider: 'codex',
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
    await expect(
      fixture.runtime.request({
        kind: 'threads',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
      }),
    ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_CODEX_FAILED' });
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
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
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
    await expect(
      fixture.runtime.request({
        kind: 'threads',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
      }),
    ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_CODEX_FAILED' });
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
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
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
  'unstarted threads list the sessions HQ created that no turn has started, which read without native history',
  // the test starts, runs, closes and archives several sessions through the fake daemon
  { timeout: 30_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const unstarted = async () => {
        const response = await fixture.runtime.request({
          kind: 'unstarted-threads',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
        });
        if (response.kind !== 'unstarted-threads') throw new Error('Missing unstarted threads');
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
      const archived = await createThread(fixture, 'archived');
      await submit(fixture, { kind: 'thread-archive', threadId: archived.id });
      await expect.poll(async () => (await thread(fixture, archived.id))?.isArchived).toBe(true);
      // a fork starts with its source's native history, so it isn't an empty session
      const fork = await submit(fixture, {
        kind: 'thread-fork',
        threadId: worked.id,
        name: 'fork',
      });
      await expect.poll(async () => (await thread(fixture, fork.threadId!))?.state).toBe('idle');
      expect(await unstarted()).toStrictEqual({
        data: [
          expect.objectContaining({
            provider: 'codex',
            nativeId: fresh.nativeId,
            name: 'fresh',
            workspaceRoot: fixture.workspaceRoot,
            state: 'idle',
            ownership: 'managed',
            managedId: fresh.id,
            historyState: 'available',
          }),
        ],
        isTruncated: false,
      });
      // its own reads answer from the record instead of native history
      const target = {
        provider: 'codex',
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
          `INSERT INTO hq_thread (id, provider, native_id, name, workspace_root, ownership, state,
          registration_action_id, created_at, updated_at)
          SELECT ?, provider, ?, ?, workspace_root, ownership, state, registration_action_id, ?, ?
          FROM hq_thread WHERE id = ?`,
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
            `INSERT INTO hq_thread (id, provider, native_id, name, workspace_root, ownership, state,
            registration_action_id, created_at, updated_at)
            SELECT ?, provider, NULL, 'unacknowledged', workspace_root, ownership, 'creating',
            registration_action_id, ?, ? FROM hq_thread WHERE id = ?`,
          )
          .run(randomUUID(), Date.now() + 64, Date.now() + 64, fresh.id);
      } finally {
        database.close();
      }
      const cut = await unstarted();
      expect(cut.isTruncated).toBe(true);
      expect(cut.data).toHaveLength(32);
      // newest first, so the first session falls past the cut, and the unacknowledged one isn't listed
      expect(cut.data[0]?.name).toBe('more-31');
      expect(cut.data.some((session) => session.nativeId === fresh.nativeId)).toBe(false);
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
