import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { createAgentHq } from 'jg-agent-hq';
import type { IActionCommand, IActionEnvelope } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { createStore } from '../../../dist/store/index.js';

import {
  withClaudeRuntime,
  waitForWarmUp,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

const actionsOf = async (fixture: IClaudeFixture) => {
  const { runtime } = fixture;
  await waitForWarmUp(runtime);
  const envelope = (command: IActionCommand): IActionEnvelope => ({
    id: randomUUID(),
    runtimeEpoch: runtime.runtimeEpoch,
    command,
  });
  const send = async (command: IActionCommand) =>
    (await runtime.request({ kind: 'action', action: envelope(command) })).result;
  const receipt = async (actionId: string) =>
    (await runtime.request({ kind: 'receipt', actionId })).result;
  const created = await send({
    kind: 'thread-create',
    provider: 'codex',
    workspaceRoot: fixture.workspaceRoot,
    name: 'workspace-proof',
  });
  await expect.poll(async () => (await receipt(created.id))?.delivery).toBe('acknowledged');
  const threadId = created.threadId!;
  const thread = async () => (await runtime.request({ kind: 'managed-thread', threadId })).result!;
  const away = join(fixture.workspaceRoot, 'part-b');
  await mkdir(away);
  const move = (expectedWorkspaceRoot: string, workspaceRoot: string): IActionCommand => ({
    kind: 'message',
    threadId,
    input: { kind: 'text', text: 'workspace transition proof' },
    workspaceChange: { expectedWorkspaceRoot, workspaceRoot },
  });
  return { envelope, send, receipt, threadId, thread, away, move };
};

const deleteCalls = async (root: string): Promise<number> =>
  (await readFile(join(root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((call) => call.method === 'thread/delete').length;

test('atomic Codex A → B → A retains identities and selected journal evidence through close', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    const original = await action.thread();
    for (const [source, target] of [
      [fixture.workspaceRoot, action.away],
      [action.away, fixture.workspaceRoot],
    ]) {
      const sent = await action.send(action.move(source!, target!));
      await expect
        .poll(async () => (await action.receipt(sent.id))?.workspaceTransition?.state)
        .toBe('confirmed');
      await expect.poll(async () => (await action.thread()).state).toBe('completed');
      expect(await action.thread()).toMatchObject({
        id: original.id,
        nativeId: original.nativeId,
        name: original.name,
        workspaceRoot: target,
      });
      expect(await action.receipt(sent.id)).toMatchObject({
        delivery: 'acknowledged',
        phase: 'turn',
        workspaceTransition: {
          actionId: sent.id,
          threadId: original.id,
          sourceWorkspaceRoot: source,
          targetWorkspaceRoot: target,
        },
      });
    }
    const listed = await fixture.runtime.request({
      kind: 'actions',
      threadId: original.id,
      limit: 8,
    });
    expect(listed.result.data.every((item) => !Object.hasOwn(item, 'workspaceTransition'))).toBe(
      true,
    );
    const closed = await action.send({ kind: 'thread-close', threadId: original.id });
    await expect.poll(async () => (await action.receipt(closed.id))?.delivery).toBe('acknowledged');
    const database = new DatabaseSync(fixture.runtime.storage.databasePath);
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
          ?.count,
      ).toBe(2);
    } finally {
      database.close();
    }
  });
});

test('an interrupted exact source cancels its workspace continuation without moving', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await action.send({
      kind: 'message',
      threadId: action.threadId,
      input: { kind: 'text', text: 'source turn' },
    });
    await expect.poll(async () => (await action.thread()).activeTurnId).not.toBeNull();
    const source = (await action.thread()).activeTurnId!;
    const queued = await action.send({
      ...action.move(fixture.workspaceRoot, action.away),
      kind: 'queue',
      expectedTurnId: source,
    } as Extract<IActionCommand, { kind: 'queue' }>);
    expect(queued).toMatchObject({
      delivery: 'queued',
      workspaceTransition: { state: 'prepared' },
    });
    await action.send({ kind: 'interrupt', threadId: action.threadId, expectedTurnId: source });
    await expect.poll(async () => (await action.receipt(queued.id))?.delivery).toBe('canceled');
    expect(await action.receipt(queued.id)).toMatchObject({
      queuedInput: null,
      workspaceTransition: { state: 'failed' },
    });
    expect((await action.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
  });
});

test('a successful exact source delivers one queued transition and blocks competing moves', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await action.send({
      kind: 'message',
      threadId: action.threadId,
      input: { kind: 'text', text: 'source turn' },
    });
    await expect.poll(async () => (await action.thread()).activeTurnId).not.toBeNull();
    const source = (await action.thread()).activeTurnId!;
    const intent = action.envelope({
      kind: 'queue',
      threadId: action.threadId,
      expectedTurnId: source,
      input: { kind: 'text', text: 'queued workspace input' },
      workspaceChange: { expectedWorkspaceRoot: fixture.workspaceRoot, workspaceRoot: action.away },
    });
    const queued = (await fixture.runtime.request({ kind: 'action', action: intent })).result;
    expect((await fixture.runtime.request({ kind: 'action', action: intent })).result.id).toBe(
      queued.id,
    );
    const competing = await action.send({
      kind: 'queue',
      threadId: action.threadId,
      expectedTurnId: source,
      input: { kind: 'text', text: 'competing' },
      workspaceChange: { expectedWorkspaceRoot: fixture.workspaceRoot, workspaceRoot: action.away },
    });
    expect(competing).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    await writeFixtureControl(fixture.root, 'control.json', { completeOnSteer: true });
    await action.send({
      kind: 'steer',
      threadId: action.threadId,
      expectedTurnId: source,
      text: 'finish the source',
    });
    await expect
      .poll(async () => (await action.receipt(queued.id))?.workspaceTransition?.state)
      .toBe('confirmed');
    expect((await action.thread()).workspaceRoot).toBe(action.away);
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter(
        (call) =>
          call.method === 'turn/start' &&
          call.params.clientUserMessageId === `${queued.id}:workspace`,
      ),
    ).toHaveLength(1);
  });
});

test('a stale source is refused before native input or journal creation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    await expectToRejectCode(
      action.send(action.move(action.away, fixture.workspaceRoot)),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toStrictEqual([]);
    const database = new DatabaseSync(fixture.runtime.storage.databasePath);
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

test('a file destination is refused before native input or journal creation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    const target = join(action.away, 'file.txt');
    await writeFile(target, 'not a workspace');
    await expectToRejectCode(
      action.send(action.move(fixture.workspaceRoot, target)),
      'JG_AGENT_HQ_REQUEST_INVALID',
    );
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toStrictEqual([]);
    const database = new DatabaseSync(fixture.runtime.storage.databasePath);
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

test.each(['ignored root', 'failed proof read'])(
  'missing destination proof (%s) stays uncertain and never repeats native input',
  async (failure) => {
    await withClaudeRuntime(async (fixture) => {
      const action = await actionsOf(fixture);
      await writeFixtureControl(
        fixture.root,
        'control.json',
        failure === 'ignored root' ? { ignoreWorkspaceChange: true } : { failWorkspaceProof: true },
      );
      const intent = action.envelope(action.move(fixture.workspaceRoot, action.away));
      await fixture.runtime.request({ kind: 'action', action: intent });
      await expect.poll(async () => (await action.receipt(intent.id))?.delivery).toBe('uncertain');
      expect(await action.receipt(intent.id)).toMatchObject({
        workspaceTransition: { state: 'uncertain' },
      });
      expect((await action.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
      await fixture.runtime.request({ kind: 'action', action: intent });
      const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        calls.filter(
          (call) =>
            call.method === 'turn/start' &&
            call.params.clientUserMessageId === `${intent.id}:workspace`,
        ),
      ).toHaveLength(1);
    });
  },
);

// cancellation can arrive while the native source inspection is held, before any input effect
test('an expired pre-effect inspection cannot send workspace input after its deadline', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    const nativeId = (await action.thread()).nativeId!;
    await writeFixtureControl(fixture.root, 'control.json', { holdReadThread: nativeId });
    const sent = await action.send(action.move(fixture.workspaceRoot, action.away));
    await expect
      .poll(async () => (await action.receipt(sent.id))?.delivery, { timeout: 35000 })
      .toBe('uncertain');
    await writeFixtureControl(fixture.root, 'control.json', { readProofMarker: true });
    await expect
      .poll(async () => {
        try {
          return await readFile(join(fixture.root, 'completed-read.txt'), 'utf8');
        } catch (error) {
          if (hasErrorCode(error, 'ENOENT')) return '';
          throw error;
        }
      })
      .toBe(nativeId);
    await fixture.runtime.request({ kind: 'models', provider: 'codex', limit: 1 });
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter(
        (call) =>
          call.method === 'turn/start' &&
          call.params.clientUserMessageId === `${sent.id}:workspace`,
      ),
    ).toStrictEqual([]);
  });
}, 45000);

// the native boundary deliberately answers after its real 30-second request deadline
test('a late exact workspace acknowledgement reconciles proof without resending input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    await writeFixtureControl(fixture.root, 'control.json', { lateTurnAck: true });
    const sent = await action.send(action.move(fixture.workspaceRoot, action.away));
    await expect
      .poll(async () => (await action.receipt(sent.id))?.delivery, { timeout: 35000 })
      .toBe('uncertain');
    await expect
      .poll(async () => (await action.receipt(sent.id))?.workspaceTransition?.state, {
        timeout: 5000,
      })
      .toBe('confirmed');
    expect(await action.receipt(sent.id)).toMatchObject({
      delivery: 'acknowledged',
      completion: 'completed',
    });
    expect((await action.thread()).workspaceRoot).toBe(action.away);
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter(
        (call) =>
          call.method === 'turn/start' &&
          call.params.clientUserMessageId === `${sent.id}:workspace`,
      ),
    ).toHaveLength(1);
  });
}, 45000);

test('confirmed native deletion survives local failure and startup completes only local cleanup', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    const moved = await action.send(action.move(fixture.workspaceRoot, action.away));
    await expect.poll(async () => (await action.receipt(moved.id))?.delivery).toBe('acknowledged');
    await expect.poll(async () => (await action.thread()).state).toBe('completed');
    const nativeId = (await action.thread()).nativeId!;
    const database = new DatabaseSync(fixture.runtime.storage.databasePath);
    let deletionId: string;
    try {
      database.exec(
        "CREATE TRIGGER hold_workspace_delete BEFORE DELETE ON agent_hq_workspace_transition BEGIN SELECT RAISE(ABORT, 'hold local deletion'); END",
      );
      const intent = action.envelope({
        kind: 'thread-delete',
        provider: 'codex',
        workspaceRoot: action.away,
        nativeId,
      });
      deletionId = intent.id;
      await expectToRejectCode(
        fixture.runtime.request({ kind: 'action', action: intent }),
        'JG_AGENT_HQ_STORE_FAILED',
      );
      expect(
        database
          .prepare('SELECT deleted_native_id FROM agent_hq_action WHERE id = ?')
          .get(deletionId)?.deleted_native_id,
      ).toBe(nativeId);
      expect(
        database.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
          ?.count,
      ).toBe(1);
      expect(await deleteCalls(fixture.root)).toBe(1);
      database.exec('DROP TRIGGER hold_workspace_delete');
    } finally {
      database.close();
    }
    await fixture.runtime.close();
    const reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      await waitForWarmUp(reopened);
      expect(
        (await reopened.request({ kind: 'managed-thread', threadId: action.threadId })).result,
      ).toBeNull();
      expect(
        (await reopened.request({ kind: 'receipt', actionId: deletionId! })).result,
      ).toMatchObject({ delivery: 'acknowledged', threadId: null });
      expect(await deleteCalls(fixture.root)).toBe(1);
      const remaining = new DatabaseSync(reopened.storage.databasePath);
      try {
        expect(
          remaining.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
            ?.count,
        ).toBe(0);
      } finally {
        remaining.close();
      }
    } finally {
      await reopened.close();
    }
  });
});

test('large journal reads stay bounded with stable equal-time cursors and identity-scoped contexts', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await actionsOf(fixture);
    await fixture.runtime.close();
    const database = new DatabaseSync(fixture.runtime.storage.databasePath, {
      enableForeignKeyConstraints: true,
    });
    try {
      database.exec('BEGIN');
      const insertAction = database.prepare(
        "INSERT INTO agent_hq_action (id, digest, requested_runtime_epoch, runtime_epoch, kind, provider, thread_id, phase, delivery, created_at, updated_at) VALUES (?, ?, ?, ?, 'message', 'codex', ?, 'turn', 'acknowledged', 1, 1)",
      );
      const insertTransition = database.prepare(
        "INSERT INTO agent_hq_workspace_transition (action_id, thread_id, source_workspace_root, target_workspace_root, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'confirmed', 1, 1)",
      );
      for (let index = 0; index < 1024; index += 1) {
        const id = `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        insertAction.run(
          id,
          '0'.repeat(64),
          fixture.runtime.runtimeEpoch,
          fixture.runtime.runtimeEpoch,
          action.threadId,
        );
        insertTransition.run(id, action.threadId, fixture.workspaceRoot, action.away);
      }
      database.exec('COMMIT');
    } finally {
      database.close();
    }
    const store = await createStore(
      fixture.runtime.storage.databasePath,
      randomUUID(),
      await readFile(join(fixture.stateRoot, 'action.key')),
    );
    try {
      const first = await store.call('workspaces', 'page', action.threadId, 128, null);
      expect(first).toHaveLength(128);
      expect(first[0]?.action_id).toBe('10000000-0000-4000-8000-0000000003ff');
      const seen = new Set(first.map((row) => row.action_id));
      let last = first.at(-1)!;
      for (let page = 0; page < 7; page += 1) {
        const rows = await store.call('workspaces', 'page', action.threadId, 128, {
          updatedAt: last.updated_at,
          actionId: last.action_id,
        });
        expect(rows).toHaveLength(128);
        for (const row of rows) {
          expect(seen.has(row.action_id)).toBe(false);
          seen.add(row.action_id);
        }
        last = rows.at(-1)!;
      }
      expect(seen.size).toBe(1024);
      expect(
        await store.call('workspaces', 'page', action.threadId, 128, {
          updatedAt: last.updated_at,
          actionId: last.action_id,
        }),
      ).toStrictEqual([]);
      expect(await store.call('workspaces', 'hasContext', action.threadId, action.away)).toBe(true);
      expect(await store.call('workspaces', 'hasContext', randomUUID(), action.away)).toBe(false);
      await expectToRejectCode(
        store.call('workspaces', 'page', action.threadId, 129, null),
        'JG_AGENT_HQ_REQUEST_INVALID',
      );
    } finally {
      await store.close();
    }
  });
});
