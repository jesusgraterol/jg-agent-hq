import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import type { IBrowserAction } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  waitForWarmUp,
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../scripts/test-support/index.js';

/** Admits a real browser send and keeps its native turn running for live reads. */
const startBrowserInput = async (
  fixture: IClaudeFixture,
  isAckHeld = false,
  provider: 'codex' | 'claude' = 'codex',
) => {
  await waitForWarmUp(fixture.runtime);
  const runtimeEpoch = (await fixture.request({ kind: 'status' })).result.runtimeEpoch;
  const created = await fixture.request({
    kind: 'action',
    action: {
      id: randomUUID(),
      runtimeEpoch,
      command: {
        kind: 'thread-create',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        name: 'live-input',
      },
    },
  });
  await fixture.request({
    kind: 'action-wait',
    actionId: created.result.id,
    until: 'settled',
    timeoutMs: 5000,
  });
  const thread = (
    await fixture.request({ kind: 'managed-thread', threadId: created.result.threadId! })
  ).result!;
  if (provider === 'claude') await fixture.control({ holdTurn: true, steer: 'join' });
  else
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      holdTurnAck: isAckHeld,
    });
  const releaseAck = async (): Promise<void> => {
    if (!isAckHeld) return;
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      releaseTurnAcks: true,
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
  };
  const text = 'Keep one visible copy of this input.';
  const browser: IBrowserAction = {
    id: randomUUID(),
    runtimeEpoch,
    command: {
      kind: 'native',
      action: {
        id: randomUUID(),
        runtimeEpoch,
        command: { kind: 'message', threadId: thread.id, input: { kind: 'text', text } },
      },
    },
  };
  try {
    const receipt = await fixture.runtime.performBrowserAction(
      browser,
      'operator',
      async (admitted, nativeActionId) => {
        await fixture.request({
          kind: 'action',
          action: { ...admitted.command.action, id: nativeActionId },
        });
      },
    );
    if (!isAckHeld) {
      const settled = await fixture.request({
        kind: 'action-wait',
        actionId: receipt.nativeActionId,
        until: 'settled',
        timeoutMs: 5000,
      });
      expect(settled.result.receipt?.delivery).toBe('acknowledged');
    }
    const readThread = async () =>
      (await fixture.request({ kind: 'managed-thread', threadId: thread.id })).result!;
    await expect.poll(async () => (await readThread()).activeTurnId).toBeTruthy();
    return {
      browser,
      receipt,
      text,
      thread,
      turnId: (await readThread()).activeTurnId!,
      releaseAck,
    };
  } catch (error) {
    await releaseAck();
    throw error;
  }
};

/** Publishes one native input without substituting a pre-correlated SDK row. */
const emitInput = async (
  fixture: IClaudeFixture,
  input: Awaited<ReturnType<typeof startBrowserInput>>,
  overrides: { clientId?: string | null; text?: string; turnId?: string } = {},
): Promise<void> => {
  await writeFixtureControl(fixture.root, 'control.json', {
    holdTurn: true,
    emitOnce: true,
    emit: [
      {
        method: 'item/completed',
        params: {
          threadId: input.thread.nativeId,
          turnId: overrides.turnId ?? input.turnId,
          item: {
            id: 'operator-input',
            type: 'userMessage',
            clientId:
              overrides.clientId === undefined
                ? `${input.receipt.nativeActionId}:turn`
                : overrides.clientId,
            content: [{ type: 'text', text: overrides.text ?? input.text }],
          },
        },
      },
    ],
  });
  await fixture.request({ kind: 'usage', provider: 'codex' });
  await expect
    .poll(async () =>
      (await fixture.request({ kind: 'live-items', threadId: input.thread.id })).result.data.map(
        (item) => item.nativeId,
      ),
    )
    .toContain('operator-input');
};

test('live input correlates the acknowledged native action and original browser identity', async () => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture);
    const { browser, receipt, thread } = input;
    await emitInput(fixture, input);
    const read = async () =>
      (await fixture.request({ kind: 'live-items', threadId: thread.id, textLimit: 8 })).result;
    await expect
      .poll(async () => (await read()).data.map((item) => item.nativeId))
      .toContain('operator-input');
    const item = (await read()).data.find((entry) => entry.nativeId === 'operator-input')!;
    expect(item.text).toBe('Keep one');
    expect(item.provenance).toMatchObject({
      origin: 'operator',
      source: 'authenticated-host-action',
      actionId: receipt.nativeActionId,
      browserActionId: browser.id,
      contentBoundary: 'untrusted',
      grantsAuthority: false,
    });
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      items: [
        {
          turnId: input.turnId,
          item: {
            id: 'operator-input',
            type: 'userMessage',
            clientId: `${receipt.nativeActionId}:turn`,
            content: [{ type: 'text', text: input.text }],
          },
        },
      ],
    });
    const saved = await fixture.request({
      kind: 'items',
      provider: 'codex',
      nativeId: thread.nativeId!,
      workspaceRoot: fixture.workspaceRoot,
      limit: 8,
    });
    expect(saved.result.data[0]!.provenance).toStrictEqual(item.provenance);
  });
});

test('Claude browser steering correlates its exact action in live and persisted input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture, false, 'claude');
    const text = 'Inspect the same queued input.';
    const browser: IBrowserAction = {
      id: randomUUID(),
      runtimeEpoch: input.browser.runtimeEpoch,
      command: {
        kind: 'native',
        action: {
          id: randomUUID(),
          runtimeEpoch: input.browser.runtimeEpoch,
          command: { kind: 'steer', threadId: input.thread.id, expectedTurnId: input.turnId, text },
        },
      },
    };
    const receipt = await fixture.runtime.performBrowserAction(
      browser,
      'operator',
      async (admitted, nativeActionId) => {
        await fixture.request({
          kind: 'action',
          action: { ...admitted.command.action, id: nativeActionId },
        });
      },
    );
    const settled = await fixture.request({
      kind: 'action-wait',
      actionId: receipt.nativeActionId,
      until: 'settled',
      timeoutMs: 5000,
    });
    expect(settled.result.receipt?.delivery).toBe('acknowledged');
    const live = (await fixture.request({ kind: 'live-items', threadId: input.thread.id })).result;
    const item = live.data.find((item) => item.text === text)!;
    expect(item.provenance).toMatchObject({
      origin: 'operator',
      source: 'authenticated-host-action',
      actionId: receipt.nativeActionId,
      browserActionId: browser.id,
      nativeInputId: receipt.nativeActionId,
      contentBoundary: 'untrusted',
      grantsAuthority: false,
    });
    const saved = await fixture.request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: input.thread.nativeId!,
    });
    expect(saved.result.data.find((entry) => entry.text === text)!.provenance).toStrictEqual(
      item.provenance,
    );
    expect(
      (await fixture.request({ kind: 'live-items', threadId: input.thread.id })).result.data.filter(
        (entry) => entry.provenance.nativeInputId === receipt.nativeActionId,
      ),
    ).toStrictEqual([]);
    await fixture.runtime.close();
    const replacement = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const restarted = await replacement.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: input.thread.nativeId!,
      });
      expect(restarted.result.data.find((entry) => entry.text === text)!.provenance).toStrictEqual(
        item.provenance,
      );
    } finally {
      await replacement.close();
    }
  });
});

test.each([
  'source',
  'hash',
  'provider',
  'session',
  'phase',
  'kind',
  'acknowledgement',
  'target',
  'turn',
  'ambiguous',
  'host',
])('Claude steer provenance requires exact acknowledged identity: %s', async (scenario) => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture, false, 'claude');
    const id = randomUUID(),
      text = 'The exact steer input.';
    await fixture.request({
      kind: 'action',
      action: {
        id,
        runtimeEpoch: input.browser.runtimeEpoch,
        command: { kind: 'steer', threadId: input.thread.id, expectedTurnId: input.turnId, text },
      },
    });
    await fixture.request({ kind: 'action-wait', actionId: id, until: 'settled', timeoutMs: 5000 });
    if (scenario === 'source' || scenario === 'hash' || scenario === 'ambiguous') {
      const path = fixture.transcript(input.thread.nativeId!);
      const rows = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (
            line,
          ): {
            type: string;
            uuid: string;
            message?: { role: string; content: string };
            attachment?: { source_uuid: string; prompt: string };
          } => JSON.parse(line),
        );
      const queued = rows.find((row) => row.attachment?.source_uuid === id)!;
      if (scenario === 'source') queued.attachment!.source_uuid = randomUUID();
      else if (scenario === 'hash') queued.attachment!.prompt = 'Different persisted text';
      else {
        queued.type = 'user';
        queued.uuid = id;
        queued.message = { role: 'user', content: text };
        delete queued.attachment;
      }
      await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    if (scenario !== 'source' && scenario !== 'hash') {
      const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        if (scenario === 'provider')
          database
            .prepare("UPDATE agent_hq_thread SET provider = 'codex' WHERE id = ?")
            .run(input.thread.id);
        if (scenario === 'session')
          database
            .prepare('UPDATE agent_hq_thread SET native_id = ? WHERE id = ?')
            .run(randomUUID(), input.thread.id);
        if (scenario === 'phase')
          database.prepare("UPDATE agent_hq_action SET phase = 'turn' WHERE id = ?").run(id);
        if (scenario === 'kind')
          database.prepare("UPDATE agent_hq_action SET kind = 'message' WHERE id = ?").run(id);
        if (scenario === 'acknowledgement')
          database
            .prepare("UPDATE agent_hq_action SET delivery = 'submitted' WHERE id = ?")
            .run(id);
        if (scenario === 'target')
          database
            .prepare('UPDATE agent_hq_action SET expected_turn_id = ? WHERE id = ?')
            .run(randomUUID(), id);
        if (scenario === 'turn')
          database
            .prepare(
              'UPDATE agent_hq_action SET native_turn_id = ?, expected_turn_id = ? WHERE id = ?',
            )
            .run('another-turn', 'another-turn', id);
        if (scenario === 'ambiguous')
          database
            .prepare(
              'UPDATE agent_hq_action SET native_turn_id = ?, input_sha256 = (SELECT input_sha256 FROM agent_hq_action WHERE id = ?) WHERE id = ?',
            )
            .run(id, id, input.receipt.nativeActionId);
      } finally {
        database.close();
      }
    }
    const result = (
      await fixture.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: input.thread.nativeId!,
      })
    ).result;
    const item = result.data.find(
      (entry) => entry.nativeType === 'attachment' || entry.provenance.nativeInputId === id,
    )!;
    expect(item.provenance).toMatchObject({
      actionId: scenario === 'host' ? id : null,
      source: scenario === 'host' ? 'host-action' : 'unknown',
      origin: 'unknown',
      contentBoundary: 'untrusted',
      grantsAuthority: false,
    });
    expect(item.provenance).not.toHaveProperty('browserActionId');
  });
});

test.each([
  ['request', { clientId: '00000000-0000-4000-8000-000000000001:turn' }],
  ['turn', { turnId: 'another-native-turn' }],
  ['content', { text: 'A different input sharing the client marker.' }],
  ['missing identity', { clientId: null }],
])('live input with mismatched %s stays uncorrelated', async (_, overrides) => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture);
    await emitInput(fixture, input, overrides);
    const item = (
      await fixture.request({ kind: 'live-items', threadId: input.thread.id })
    ).result.data.find((entry) => entry.nativeId === 'operator-input')!;
    expect(item.provenance).toMatchObject({
      origin: 'unknown',
      source: 'unknown',
      actionId: null,
      contentBoundary: 'untrusted',
      grantsAuthority: false,
    });
    expect(item.provenance).not.toHaveProperty('browserActionId');
  });
});

test('acknowledgement wakes a conditional live read with newly verified input identity', async () => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture, true);
    try {
      await emitInput(fixture, input);
      const before = (await fixture.request({ kind: 'live-items', threadId: input.thread.id }))
        .result;
      expect(
        before.data.find((item) => item.nativeId === 'operator-input')!.provenance.actionId,
      ).toBeNull();
      const waiting = fixture.request({
        kind: 'live-items',
        threadId: input.thread.id,
        afterRevision: before.revision,
        waitMs: 5000,
      });
      await input.releaseAck();
      const after = (await waiting).result;
      expect(after.unchanged).toBe(false);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(
        after.data.find((item) => item.nativeId === 'operator-input')!.provenance,
      ).toMatchObject({
        actionId: input.receipt.nativeActionId,
        browserActionId: input.browser.id,
        origin: 'operator',
        grantsAuthority: false,
      });
    } finally {
      await input.releaseAck();
    }
  });
});

test('a separate host input with identical text retains its own identity without a browser link', async () => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture);
    const actionId = randomUUID();
    await fixture.request({
      kind: 'action',
      action: {
        id: actionId,
        runtimeEpoch: input.browser.runtimeEpoch,
        command: {
          kind: 'steer',
          threadId: input.thread.id,
          expectedTurnId: input.turnId,
          text: input.text,
        },
      },
    });
    const settled = await fixture.request({
      kind: 'action-wait',
      actionId,
      until: 'settled',
      timeoutMs: 5000,
    });
    expect(settled.result.receipt?.delivery).toBe('acknowledged');
    await emitInput(fixture, input, { clientId: `${actionId}:steer` });
    const item = (
      await fixture.request({ kind: 'live-items', threadId: input.thread.id })
    ).result.data.find((entry) => entry.nativeId === 'operator-input')!;
    expect(item.provenance).toMatchObject({ actionId, origin: 'unknown', source: 'host-action' });
    expect(item.provenance).not.toHaveProperty('browserActionId');
  });
});

test('a native input cannot carry browser provenance into another session', async () => {
  await withClaudeRuntime(async (fixture) => {
    const input = await startBrowserInput(fixture);
    const created = await fixture.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: input.browser.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'other-live-input',
        },
      },
    });
    await fixture.request({
      kind: 'action-wait',
      actionId: created.result.id,
      until: 'settled',
      timeoutMs: 5000,
    });
    const thread = (
      await fixture.request({ kind: 'managed-thread', threadId: created.result.threadId! })
    ).result!;
    await emitInput(fixture, { ...input, thread });
    const item = (
      await fixture.request({ kind: 'live-items', threadId: thread.id })
    ).result.data.find((entry) => entry.nativeId === 'operator-input')!;
    expect(item.provenance).toMatchObject({ actionId: null, origin: 'unknown', source: 'unknown' });
    expect(item.provenance).not.toHaveProperty('browserActionId');
  });
});
