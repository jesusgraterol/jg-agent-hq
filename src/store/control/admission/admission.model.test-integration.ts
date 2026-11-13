// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expectToRejectCode } from 'jg-exception/testing';
import type { IActionCommand, IActionReceipt, IManagedThread } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  claudeRecord,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../../scripts/test-support/index.js';

// the action helpers one runtime's admission scenarios share
const actionsOf = async (fixture: IClaudeFixture) => {
  const status = await fixture.runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  const envelope = (command: IActionCommand) => ({
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command,
  });
  const submit = async (command: IActionCommand): Promise<IActionReceipt> => {
    const response = await fixture.runtime.request({ kind: 'action', action: envelope(command) });
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
  const createThread = async (name: string): Promise<IManagedThread> => {
    const admitted = await submit({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name,
    });
    await expect.poll(async () => (await receipt(admitted.id))?.delivery).toBe('acknowledged');
    return (await thread(admitted.threadId!))!;
  };
  // a refusal admission records, as an action failed on its state
  const expectFailed = async (command: IActionCommand): Promise<IActionReceipt> => {
    const refused = await submit(command);
    expect(refused).toMatchObject({ delivery: 'failed', failure: 'state-conflict', phase: null });
    return refused;
  };
  return { submit, receipt, thread, createThread, expectFailed };
};

test.each(['claude', 'codex'] as const)(
  '%s controller readiness never reports a completed turn before input',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const { submit, receipt, thread } = await actionsOf(fixture);
      const created = await submit({
        kind: 'thread-create',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        name: 'controller-readiness',
      });
      await expect.poll(async () => (await receipt(created.id))?.delivery).toBe('acknowledged');
      const threadId = created.threadId!;
      if (provider === 'claude') {
        const nativeId = (await thread(threadId))!.nativeId!;
        await writeFile(
          fixture.transcript(nativeId),
          `${JSON.stringify(claudeRecord(fixture.workspaceRoot, nativeId, { type: 'assistant', text: 'Earlier saved reply' }))}\n`,
        );
      }
      const transitions = async () => {
        const response = await fixture.runtime.request({ kind: 'session-states', limit: 128 });
        if (response.kind !== 'session-states') throw new Error('Missing transitions');
        expect(response.result.hasMore).toBe(false);
        return response.result.data.filter((entry) => entry.threadId === threadId);
      };
      for (let reopening = 0; reopening < 2; reopening += 1) {
        const closed = await submit({ kind: 'thread-close', threadId });
        await expect.poll(async () => (await receipt(closed.id))?.delivery).toBe('acknowledged');
        const resumed = await submit({
          kind: 'thread-resume',
          threadId,
          operatorConfirmation: 'Other native controllers are closed',
        });
        await expect.poll(async () => (await receipt(resumed.id))?.delivery).toBe('acknowledged');
        expect(await thread(threadId)).toMatchObject({ state: 'idle', activeTurnId: null });
        expect(
          (await transitions()).filter((entry) =>
            ['turn-started', 'turn-completed'].includes(entry.reason),
          ),
        ).toStrictEqual([]);
      }
      const message = await submit({
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Complete one actual turn' },
      });
      await expect.poll(async () => (await receipt(message.id))?.completion).toBe('completed');
      expect(
        (await transitions())
          .filter((entry) => ['turn-started', 'turn-completed'].includes(entry.reason))
          .map((entry) => entry.reason),
      ).toStrictEqual(['turn-started', 'turn-completed']);
    });
  },
);

test('a running turn refuses each kind that needs an idle thread, its exact turn, a queued entry or a free name', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { submit, thread, createThread, expectFailed } = await actionsOf(fixture);
    const named = await createThread('taken-name');
    const target = await createThread('busy-thread');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    const running = await submit({
      kind: 'message',
      threadId: target.id,
      input: { kind: 'text', text: 'Keep running' },
    });
    await expect.poll(async () => (await thread(target.id))?.state).toBe('running');
    const threadId = target.id;
    // an idle thread is required to start a turn or close
    await expectFailed({ kind: 'message', threadId, input: { kind: 'text', text: 'Another' } });
    await expectFailed({ kind: 'thread-close', threadId });
    // the turn a command names must be the active one
    await expectFailed({
      kind: 'queue',
      threadId,
      expectedTurnId: 'another-turn',
      input: { kind: 'text', text: 'Next' },
    });
    await expectFailed({ kind: 'steer', threadId, expectedTurnId: 'another-turn', text: 'Turn' });
    await expectFailed({ kind: 'interrupt', threadId, expectedTurnId: 'another-turn' });
    // a queued entry is required to send or cancel one
    await expectFailed({ kind: 'queue-send', queuedActionId: running.id });
    await expectFailed({ kind: 'queue-cancel', queuedActionId: running.id });
    // a rename needs a name no other thread holds
    await expectFailed({ kind: 'thread-rename', threadId, name: named.name });
    // a reply needs the live native request it answers
    await expectToRejectCode(
      submit({
        kind: 'native-reply',
        threadId,
        expectedTurnId: (await thread(threadId))!.activeTurnId!,
        approvalId: randomUUID(),
        response: { kind: 'decision', decision: 'accept' },
      }),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    expect(await thread(threadId)).toMatchObject({ state: 'running', name: 'busy-thread' });
  });
});

test('one of two concurrent resumes of a closed thread is admitted, and an open thread refuses resume and recovery', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { submit, receipt, thread, createThread } = await actionsOf(fixture);
    const closed = await createThread('closed-thread');
    const close = await submit({ kind: 'thread-close', threadId: closed.id });
    await expect.poll(async () => (await receipt(close.id))?.delivery).toBe('acknowledged');
    expect(await thread(closed.id)).toMatchObject({ state: 'inactive', runtimeEpoch: null });
    const resume = (threadId: string): IActionCommand => ({
      kind: 'thread-resume',
      threadId,
      operatorConfirmation: 'No other CLI controller owns this session',
    });
    // both pass their native checks, and admission takes the thread for one
    const resumes = await Promise.all([submit(resume(closed.id)), submit(resume(closed.id))]);
    expect(resumes.map((entry) => entry.delivery).sort()).toStrictEqual(['failed', 'submitted']);
    expect(resumes.find((entry) => entry.delivery === 'failed')).toMatchObject({
      failure: 'state-conflict',
      phase: null,
    });
    const admitted = resumes.find((entry) => entry.delivery === 'submitted')!;
    expect(admitted.phase).toBe('resume');
    await expect.poll(async () => (await receipt(admitted.id))?.delivery).toBe('acknowledged');
    // a session this runtime has open is neither resumed nor recovered
    const open = await createThread('open-thread');
    await expectToRejectCode(submit(resume(open.id)), 'JG_AGENT_HQ_ACTION_CONFLICT');
    await expectToRejectCode(
      submit({
        kind: 'thread-recover',
        threadId: open.id,
        recovery: { kind: 'resume' },
        operatorConfirmation: 'No other CLI controller owns this session',
      }),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    expect(await thread(open.id)).toMatchObject({ ownership: 'managed', state: 'idle' });
  });
});

test('a native session can be adopted once, and the controlled-session capacity refuses another create', async () => {
  await withClaudeRuntime(async (fixture) => {
    const { submit, receipt } = await actionsOf(fixture);
    const adopt = (name: string): IActionCommand => ({
      kind: 'thread-adopt',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: 'external-thread',
      name,
      operatorConfirmation: 'The native CLI session has been closed',
    });
    // concurrent adoptions of one session pass their native checks, and admission takes one
    const adoptions = await Promise.all([submit(adopt('adopt-one')), submit(adopt('adopt-two'))]);
    expect(adoptions.map((entry) => entry.delivery).sort()).toStrictEqual(['failed', 'submitted']);
    // the adopted session is one of 32 this runtime may control
    const creates = await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        submit({
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: `capacity-${index}`,
        }),
      ),
    );
    expect(creates.every((entry) => entry.delivery === 'submitted')).toBe(true);
    const refused = await submit({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name: 'over-capacity',
    });
    expect(refused).toMatchObject({ delivery: 'failed', failure: 'state-conflict', phase: null });
    for (const entry of [...adoptions.filter((item) => item.delivery !== 'failed'), ...creates])
      await expect.poll(async () => (await receipt(entry.id))?.delivery).toBe('acknowledged');
  });
});
