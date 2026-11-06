// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import { createAgentHq } from 'jg-agent-hq';
import type { IActionCommand, IActionReceipt, IManagedThread } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { projectDirectory } from '../../../../dist/providers/claude/history/index.js';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../../scripts/test-support/index.js';

// the action helpers one runtime's phase scenarios share
const actionsOf = async (fixture: IClaudeFixture) => {
  const status = await fixture.runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  const envelope = (command: IActionCommand) => ({
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command,
  });
  const submit = async (action: ReturnType<typeof envelope>): Promise<IActionReceipt> => {
    const response = await fixture.runtime.request({ kind: 'action', action });
    if (response.kind !== 'action') throw new Error('Missing action receipt');
    return response.result;
  };
  const receipt = async (id: string): Promise<IActionReceipt | null> => {
    const response = await fixture.runtime.request({ kind: 'receipt', actionId: id });
    return response.kind === 'receipt' ? response.result : null;
  };
  const thread = async (id: string): Promise<IManagedThread | null> => {
    const response = await fixture.runtime.request({ kind: 'managed-thread', threadId: id });
    return response.kind === 'managed-thread' ? response.result : null;
  };
  // the phase the action ledger's column holds for an action
  const storedPhase = (id: string): unknown => {
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      return database.prepare('SELECT phase FROM agent_hq_action WHERE id = ?').get(id)?.phase;
    } finally {
      database.close();
    }
  };
  // the turns the Codex fixture started, with the input ID each carried
  const startedTurns = async () =>
    (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.object({ method: z.string(), params: z.unknown() }).parse(JSON.parse(line)))
      .filter((call) => call.method === 'turn/start')
      .map((call) => z.object({ clientUserMessageId: z.string() }).parse(call.params));
  const createThread = async (name: string, provider: 'codex' | 'claude' = 'codex') => {
    const action = envelope({
      kind: 'thread-create',
      provider,
      workspaceRoot: fixture.workspaceRoot,
      name,
    });
    const admitted = await submit(action);
    await expect.poll(async () => (await receipt(action.id))?.delivery).toBe('acknowledged');
    return { action, admitted, threadId: admitted.threadId! };
  };
  return { envelope, submit, receipt, thread, storedPhase, startedTurns, createThread };
};

test('Claude native deletion is confirmed before local index cleanup and recovery never deletes a recreated transcript', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actionsOf(fixture);
    const { threadId } = await api.createThread('claude-delete-proof', 'claude');
    const nativeId = (await api.thread(threadId))!.nativeId!;
    const away = join(fixture.workspaceRoot, 'part-b');
    await mkdir(away);
    const moved = api.envelope({
      kind: 'message',
      threadId,
      input: { kind: 'text', text: 'Complete this unit' },
      workspaceChange: { expectedWorkspaceRoot: fixture.workspaceRoot, workspaceRoot: away },
    });
    await api.submit(moved);
    await expect.poll(async () => (await api.receipt(moved.id))?.completion).toBe('completed');
    await fixture.runtime.request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot: away,
      nativeId,
      limit: 1,
    });
    const transcript = join(projectDirectory(away), nativeId + '.jsonl');
    const database = new DatabaseSync(fixture.runtime.storage.databasePath);
    const deletion = api.envelope({
      kind: 'thread-delete',
      provider: 'claude',
      workspaceRoot: away,
      nativeId,
    });
    try {
      database.exec(
        "CREATE TRIGGER hold_history_delete BEFORE DELETE ON agent_hq_claude_file BEGIN SELECT RAISE(ABORT, 'hold local history deletion'); END",
      );
      await expectToRejectCode(api.submit(deletion), 'JG_AGENT_HQ_STORE_FAILED');
      expect(
        database
          .prepare('SELECT deleted_native_id FROM agent_hq_action WHERE id = ?')
          .get(deletion.id)?.deleted_native_id,
      ).toBe(nativeId);
      expect(
        database
          .prepare(
            'SELECT count(*) AS count FROM agent_hq_workspace_transition WHERE thread_id = ?',
          )
          .get(threadId)?.count,
      ).toBe(1);
      await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(transcript, 'new native transcript after confirmed deletion\n', {
        flag: 'wx',
      });
      database.exec('DROP TRIGGER hold_history_delete');
    } finally {
      database.close();
    }
    await fixture.runtime.close();
    const reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect(
        (await reopened.request({ kind: 'receipt', actionId: deletion.id })).result,
      ).toMatchObject({ delivery: 'acknowledged', threadId: null });
      expect((await reopened.request({ kind: 'managed-thread', threadId })).result).toBeNull();
      expect((await reopened.request({ kind: 'action', action: deletion })).result.delivery).toBe(
        'acknowledged',
      );
      expect(await readFile(transcript, 'utf8')).toBe(
        'new native transcript after confirmed deletion\n',
      );
      const remaining = new DatabaseSync(reopened.storage.databasePath);
      try {
        expect(
          remaining
            .prepare('SELECT count(*) AS count FROM agent_hq_claude_file WHERE native_id = ?')
            .get(nativeId)?.count,
        ).toBe(0);
        expect(
          remaining
            .prepare(
              'SELECT count(*) AS count FROM agent_hq_workspace_transition WHERE thread_id = ?',
            )
            .get(threadId)?.count,
        ).toBe(0);
      } finally {
        remaining.close();
      }
    } finally {
      await reopened.close();
    }
  });
});

test('a create records its create phase, then continues in its name phase once the session exists', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { receipt, thread, storedPhase, createThread } = await actionsOf(fixture);
    const { action, admitted, threadId } = await createThread('phase-create');
    // admission records the phase the dispatch takes first
    expect(admitted).toMatchObject({ phase: 'create' });
    // the created session's naming is the action's next phase, which completes it
    expect(await receipt(action.id)).toMatchObject({
      phase: 'name',
      delivery: 'acknowledged',
    });
    expect(storedPhase(action.id)).toBe('name');
    expect(await thread(threadId)).toMatchObject({ name: 'phase-create', state: 'idle' });
  });
});

test("a message records its turn phase, and Codex receives the turn's input under the action and that phase", async () => {
  await withClaudeRuntime(async (fixture) => {
    const { envelope, submit, receipt, storedPhase, startedTurns, createThread } =
      await actionsOf(fixture);
    const { threadId } = await createThread('phase-turn');
    const message = envelope({
      kind: 'message',
      threadId,
      input: { kind: 'text', text: 'Summarize the phase column' },
    });
    expect(await submit(message)).toMatchObject({ phase: 'turn' });
    await expect.poll(async () => (await receipt(message.id))?.completion).toBe('completed');
    expect(storedPhase(message.id)).toBe('turn');
    expect(await startedTurns()).toStrictEqual([{ clientUserMessageId: `${message.id}:turn` }]);
  });
});

test('an interrupt records its interrupt phase and stops the running turn it names', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { envelope, submit, receipt, thread, storedPhase, createThread } =
      await actionsOf(fixture);
    const { threadId } = await createThread('phase-interrupt');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await submit(
      envelope({ kind: 'message', threadId, input: { kind: 'text', text: 'Run until stopped' } }),
    );
    await expect.poll(async () => (await thread(threadId))?.state).toBe('running');
    const activeTurnId = (await thread(threadId))!.activeTurnId!;
    const interrupt = envelope({ kind: 'interrupt', threadId, expectedTurnId: activeTurnId });
    expect(await submit(interrupt)).toMatchObject({ phase: 'interrupt' });
    await expect.poll(async () => (await receipt(interrupt.id))?.delivery).toBe('acknowledged');
    expect(storedPhase(interrupt.id)).toBe('interrupt');
    await expect.poll(async () => (await thread(threadId))?.state).toBe('interrupted');
  });
});

test('a repeated action never sends its phase again, and the ledger refuses a second record of it or an unknown phase', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { envelope, submit, receipt, startedTurns, createThread } = await actionsOf(fixture);
    const { threadId } = await createThread('phase-duplicate');
    const message = envelope({
      kind: 'message',
      threadId,
      input: { kind: 'text', text: 'Send this once' },
    });
    await submit(message);
    await expect.poll(async () => (await receipt(message.id))?.completion).toBe('completed');
    // the same action again returns its receipt without a second native turn
    expect(await submit(message)).toMatchObject({
      id: message.id,
      phase: 'turn',
      delivery: 'acknowledged',
    });
    expect(await startedTurns()).toStrictEqual([{ clientUserMessageId: `${message.id}:turn` }]);
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { timeout: 5000 });
    try {
      // an action, its runtime and its phase name exactly one record
      expect(() =>
        database
          .prepare(
            "INSERT INTO agent_hq_action (id, digest, requested_runtime_epoch, runtime_epoch, kind, phase, delivery, created_at, updated_at) SELECT id, digest, requested_runtime_epoch, runtime_epoch, kind, phase, 'submitted', 0, 0 FROM agent_hq_action WHERE id = ?",
          )
          .run(message.id),
      ).toThrow('UNIQUE constraint failed: agent_hq_action.id');
      expect(() =>
        database
          .prepare("UPDATE agent_hq_action SET phase = 'rewind' WHERE id = ?")
          .run(message.id),
      ).toThrow('CHECK constraint failed');
    } finally {
      database.close();
    }
    expect(await receipt(message.id)).toMatchObject({ phase: 'turn', delivery: 'acknowledged' });
  });
});
