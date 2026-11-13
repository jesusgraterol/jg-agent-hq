// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import type { IActionCommand } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../../scripts/test-support/index.js';

import { createStatements } from '../../utilities.js';

import { ControlLifecycle } from './lifecycle.model.js';

/** Creates a real controlled Claude identity and waits for its durable creation acknowledgement. */
const createClaudeThread = async (fixture: IClaudeFixture, name: string) => {
  const { runtime, workspaceRoot } = fixture;
  const response = await runtime.request({
    kind: 'action',
    action: {
      id: randomUUID(),
      runtimeEpoch: runtime.runtimeEpoch,
      command: { kind: 'thread-create', provider: 'claude', workspaceRoot, name },
    },
  });
  await expect
    .poll(
      async () => (await runtime.request({ kind: 'receipt', actionId: response.result.id })).result,
    )
    .toMatchObject({ delivery: 'acknowledged' });
  return {
    actionId: response.result.id,
    thread: (await runtime.request({ kind: 'managed-thread', threadId: response.result.threadId! }))
      .result!,
  };
};

// the runtime epoch of each native observation the state root holds to recognize a repeated one
const readEventEpochs = (stateRoot: string): string[] => {
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT runtime_epoch FROM agent_hq_event ORDER BY sequence')
      .all()
      .map((row) => z.object({ runtime_epoch: z.string() }).parse(row).runtime_epoch);
  } finally {
    database.close();
  }
};

test('startup deletes the observations earlier runtimes recorded, and the new runtime still recognizes a repeated one', async () => {
  await withClaudeRuntime(async ({ root, stateRoot, workspaceRoot, runtime, request }) => {
    await runtime.close();
    // rows two earlier runtimes left
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      const insert = database.prepare(
        'INSERT INTO agent_hq_event (runtime_epoch, event_key, digest) VALUES (?, ?, ?)',
      );
      for (const epoch of [randomUUID(), randomUUID()])
        for (const key of ['a', 'b']) insert.run(epoch, key.repeat(64), 'c'.repeat(64));
    } finally {
      database.close();
    }
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect(readEventEpochs(stateRoot)).toStrictEqual([]);
      const status = await request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime status');
      const { runtimeEpoch } = status.result;
      const submit = async (command: IActionCommand) => {
        const response = await request({
          kind: 'action',
          action: { id: randomUUID(), runtimeEpoch, command },
        });
        if (response.kind !== 'action') throw new Error('Missing action receipt');
        return response.result;
      };
      const readThread = async (threadId: string) => {
        const response = await request({ kind: 'managed-thread', threadId });
        return response.kind === 'managed-thread' ? response.result : null;
      };
      const created = await submit({
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot,
        name: 'repeated-start',
      });
      await expect
        .poll(async () => (await readThread(created.threadId!))?.state, { timeout: 5_000 })
        .toBe('idle');
      await writeFixtureControl(root, 'control.json', { holdTurn: true });
      await submit({
        kind: 'message',
        threadId: created.threadId!,
        input: { kind: 'text', text: 'Keep working' },
      });
      await expect
        .poll(async () => (await readThread(created.threadId!))?.activeTurnId, { timeout: 5_000 })
        .not.toBeNull();
      const thread = (await readThread(created.threadId!))!;
      // the turn's start is this runtime's first observation
      expect(readEventEpochs(stateRoot)).toStrictEqual([runtimeEpoch]);
      // the same start again adds nothing, while a request resolution after it adds its row
      await writeFixtureControl(root, 'control.json', {
        holdTurn: true,
        emitOnce: true,
        emit: [
          {
            method: 'turn/started',
            params: {
              threadId: thread.nativeId,
              turn: { id: thread.activeTurnId, status: 'inProgress' },
            },
          },
          {
            method: 'serverRequest/resolved',
            params: { threadId: thread.nativeId, requestId: 'marker' },
          },
        ],
      });
      await request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(() => readEventEpochs(stateRoot), { timeout: 5_000 })
        .toStrictEqual([runtimeEpoch, runtimeEpoch]);
      expect(await readThread(thread.id)).toMatchObject({
        state: 'running',
        ownership: 'managed',
        activeTurnId: thread.activeTurnId,
      });
    } finally {
      await reopened.close();
    }
  });
});

test('targeted release refuses mismatched identity, workspace or epoch and changes only its thread', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { runtime, workspaceRoot } = fixture;
    const created = await Promise.all(
      ['release-left', 'release-right'].map(
        async (name) => (await createClaudeThread(fixture, name)).thread,
      ),
    );
    // the owning runtime proves shutdown before the isolated model exercises release predicates
    await runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      const epoch = randomUUID();
      const [left, right] = created;
      database
        .prepare(
          "UPDATE agent_hq_thread SET runtime_epoch = ?, ownership = 'uncertain', state = 'unknown' WHERE id IN (?, ?)",
        )
        .run(epoch, left!.id, right!.id);
      const lifecycle = new ControlLifecycle(
        database,
        createStatements(database),
        epoch,
        await readFile(join(fixture.stateRoot, 'action.key')),
      );
      const readState = (threadId: string) =>
        database
          .prepare('SELECT ownership, state, runtime_epoch FROM agent_hq_thread WHERE id = ?')
          .get(threadId);
      const original = readState(right!.id);
      for (const target of [
        { threadId: right!.id, nativeId: left!.nativeId!, workspaceRoot, epoch },
        { threadId: left!.id, nativeId: randomUUID(), workspaceRoot, epoch },
        {
          threadId: left!.id,
          nativeId: left!.nativeId!,
          workspaceRoot: join(workspaceRoot, 'other'),
          epoch,
        },
        { threadId: left!.id, nativeId: left!.nativeId!, workspaceRoot, epoch: randomUUID() },
      ])
        expect(
          lifecycle.releaseControl(
            target.threadId,
            target.nativeId,
            target.workspaceRoot,
            target.epoch,
          ),
        ).toBeNull();
      expect(readState(left!.id)).toStrictEqual(original);
      expect(
        lifecycle.releaseControl(left!.id, left!.nativeId!, workspaceRoot, epoch),
      ).toMatchObject({
        id: left!.id,
        ownership: 'managed',
        state: 'inactive',
        runtimeEpoch: null,
      });
      expect(readState(right!.id)).toStrictEqual(original);
      expect(lifecycle.releaseControl(left!.id, left!.nativeId!, workspaceRoot, epoch)).toBeNull();
    } finally {
      database.close();
    }
  });
});

test('an ended controller action cannot release another action, conversation or runtime reservation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { runtime, workspaceRoot } = fixture;
    const { thread: left } = await createClaudeThread(fixture, 'ended-left');
    const { thread: right } = await createClaudeThread(fixture, 'ended-right');
    const rename = async (threadId: string, name: string) => {
      const id = randomUUID();
      await runtime.request({
        kind: 'action',
        action: {
          id,
          runtimeEpoch: runtime.runtimeEpoch,
          command: { kind: 'thread-rename', threadId, name },
        },
      });
      await expect
        .poll(async () => (await runtime.request({ kind: 'receipt', actionId: id })).result)
        .toMatchObject({ delivery: 'acknowledged' });
      return id;
    };
    const older = await rename(left.id, 'ended-left-old');
    const replacement = await rename(left.id, 'ended-left-new');
    const peer = await rename(right.id, 'ended-right-current');
    // no native process remains while the isolated real ledger exercises finalizer predicates
    await runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      const epoch = randomUUID();
      database
        .prepare(
          "UPDATE agent_hq_thread SET runtime_epoch = ?, ownership = 'uncertain', state = 'unknown', pending_action_id = ? WHERE id = ?",
        )
        .run(epoch, older, left.id);
      database
        .prepare(
          "UPDATE agent_hq_thread SET runtime_epoch = ?, ownership = 'uncertain', state = 'unknown', pending_action_id = ? WHERE id = ?",
        )
        .run(epoch, peer, right.id);
      database
        .prepare(
          "UPDATE agent_hq_action SET runtime_epoch = ?, delivery = 'uncertain' WHERE id IN (?, ?, ?)",
        )
        .run(epoch, older, replacement, peer);
      const lifecycle = new ControlLifecycle(
        database,
        createStatements(database),
        epoch,
        await readFile(join(fixture.stateRoot, 'action.key')),
      );
      const read = (threadId: string) =>
        database
          .prepare(
            'SELECT pending_action_id, ownership, state, runtime_epoch FROM agent_hq_thread WHERE id = ?',
          )
          .get(threadId);
      const originalPeer = read(right.id);
      for (const target of [
        { actionId: randomUUID(), nativeId: left.nativeId!, workspaceRoot, epoch },
        { actionId: older, nativeId: right.nativeId!, workspaceRoot, epoch },
        {
          actionId: older,
          nativeId: left.nativeId!,
          workspaceRoot: join(workspaceRoot, 'other'),
          epoch,
        },
        { actionId: older, nativeId: left.nativeId!, workspaceRoot, epoch: randomUUID() },
      ])
        expect(
          lifecycle.releaseEndedControlAction(
            target.actionId,
            target.nativeId,
            target.workspaceRoot,
            target.epoch,
          ),
        ).toBeNull();
      expect(read(left.id)?.pending_action_id).toBe(older);
      database.prepare("UPDATE agent_hq_action SET delivery = 'submitted' WHERE id = ?").run(older);
      expect(
        lifecycle.releaseEndedControlAction(older, left.nativeId!, workspaceRoot, epoch),
      ).toBeNull();
      database.prepare("UPDATE agent_hq_action SET delivery = 'uncertain' WHERE id = ?").run(older);
      database
        .prepare('UPDATE agent_hq_thread SET pending_action_id = ? WHERE id = ?')
        .run(replacement, left.id);
      expect(
        lifecycle.releaseEndedControlAction(older, left.nativeId!, workspaceRoot, epoch),
      ).toBeNull();
      expect(read(left.id)?.pending_action_id).toBe(replacement);
      expect(
        lifecycle.releaseEndedControlAction(replacement, left.nativeId!, workspaceRoot, epoch),
      ).toMatchObject({
        id: left.id,
        ownership: 'uncertain',
        state: 'unknown',
        runtimeEpoch: epoch,
      });
      expect(read(left.id)?.pending_action_id).toBeNull();
      expect(read(right.id)).toStrictEqual(originalPeer);
      expect(
        database.prepare('SELECT delivery FROM agent_hq_action WHERE id = ?').get(older)?.delivery,
      ).toBe('uncertain');
      expect(
        lifecycle.releaseEndedControlAction(replacement, left.nativeId!, workspaceRoot, epoch),
      ).toBeNull();
    } finally {
      database.close();
    }
  });
});

test.each(['idle', 'active'] as const)(
  'shutdown preserves quarantined Codex evidence for explicit recovery of a loaded %s session',
  async (nativeState) => {
    await withClaudeRuntime(async ({ root, stateRoot, workspaceRoot, runtime }) => {
      const originalEpoch = (await runtime.request({ kind: 'status' })).result.runtimeEpoch;
      const action = (command: IActionCommand) => ({
        id: randomUUID(),
        runtimeEpoch: originalEpoch,
        command,
      });
      const created = (
        await runtime.request({
          kind: 'action',
          action: action({
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot,
            name: 'quarantined-at-shutdown',
          }),
        })
      ).result;
      const threadId = created.threadId!;
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({ result: { state: 'idle' } });
      await writeFixtureControl(root, 'control.json', { holdTurn: true });
      const message = action({
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Do not repeat this input' },
      });
      await runtime.request({ kind: 'action', action: message });
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: message.id }))
        .toMatchObject({ result: { delivery: 'acknowledged' } });
      const held = (await runtime.request({ kind: 'managed-thread', threadId })).result!;
      const queued = action({
        kind: 'queue',
        threadId,
        expectedTurnId: held.activeTurnId!,
        input: { kind: 'text', text: 'Keep this queued input paused' },
      });
      await runtime.request({ kind: 'action', action: queued });
      await writeFixtureControl(root, 'control.json', {
        disconnectOnce: true,
        holdTurn: true,
        threadStatuses: { [held.nativeId!]: { type: 'systemError' } },
        threadTurns: {
          [held.nativeId!]: [
            {
              id: 'external-turn-after-loss',
              status: nativeState === 'active' ? 'inProgress' : 'completed',
            },
          ],
        },
      });
      await runtime.request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({ result: { ownership: 'uncertain', state: 'unknown' } });
      await runtime.close();
      await writeFixtureControl(root, 'control.json', {
        holdTurn: true,
        threadStatuses: { [held.nativeId!]: { type: nativeState, activeFlags: [] } },
        threadTurns: {
          [held.nativeId!]: [
            {
              id: 'external-turn-after-loss',
              status: nativeState === 'active' ? 'inProgress' : 'completed',
            },
          ],
        },
      });
      const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
      try {
        const retained = (await reopened.request({ kind: 'managed-thread', threadId })).result!;
        expect(retained).toMatchObject({
          id: threadId,
          nativeId: held.nativeId,
          ownership: 'uncertain',
          state: 'unknown',
          runtimeEpoch: originalEpoch,
          activeTurnId: held.activeTurnId,
        });
        const runtimeEpoch = (await reopened.request({ kind: 'status' })).result.runtimeEpoch;
        const recovery = {
          id: randomUUID(),
          runtimeEpoch,
          command: {
            kind: 'thread-recover' as const,
            threadId,
            recovery: { kind: 'resume' as const },
            operatorConfirmation:
              'The exact producing runtime has stopped; rejoin the inspected identity',
          },
        };
        await reopened.request({ kind: 'action', action: recovery });
        expect(
          (
            await reopened.request({
              kind: 'action-wait',
              actionId: recovery.id,
              until: 'settled',
              timeoutMs: 5000,
            })
          ).result,
        ).toMatchObject({ isTimedOut: false, receipt: { delivery: 'acknowledged' } });
        expect((await reopened.request({ kind: 'managed-thread', threadId })).result).toMatchObject(
          {
            ownership: 'managed',
            runtimeEpoch,
            state: nativeState === 'active' ? 'running' : 'completed',
            activeTurnId: nativeState === 'active' ? 'external-turn-after-loss' : null,
          },
        );
        expect(
          (await reopened.request({ kind: 'receipt', actionId: queued.id })).result,
        ).toMatchObject({ delivery: 'queued' });
        const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
        expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
        expect(calls.filter((call) => call.method === 'thread/resume')).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    });
  },
);
