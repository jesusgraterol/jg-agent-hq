// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('a session another Codex client drives stays external and takes input only after handover', async () => {
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
    await broadcast(fixture, { type: 'active', activeFlags: ['waitingOnApproval'] });
    await broadcast(fixture, { type: 'idle' });
    await expect
      .poll(async () => (await transitions(fixture)).map(summary))
      .toStrictEqual([
        [EXTERNAL, null, 'waiting', 'waiting-for-input', 'external'],
        [EXTERNAL, 'waiting', 'idle', 'turn-completed', 'external'],
      ]);
    const handover = {
      kind: 'thread-adopt' as const,
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: EXTERNAL,
      name: 'handover',
      operatorConfirmation: 'Closed in the terminal',
    };
    // still loaded by the terminal, so it cannot be handed over
    await expect(submit(fixture, handover)).rejects.toMatchObject({
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    });
    await broadcast(fixture, { type: 'notLoaded' });
    await expect
      .poll(async () => (await transitions(fixture)).slice(2).map(summary))
      .toStrictEqual([[EXTERNAL, 'idle', 'closed', 'closed', 'external']]);
    expect((await calls(fixture)).some((call) => call.method === 'turn/start')).toBe(false);
    const adopted = await submit(fixture, handover);
    await expect
      .poll(async () => (await receipt(fixture, adopted.id))?.delivery)
      .toBe('acknowledged');
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
