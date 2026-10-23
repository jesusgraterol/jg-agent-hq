// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import type { IActionCommand, IActionEnvelope, IManagedThread } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  claudeRecord,
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../../../scripts/test-support/claude-runtime.js';

const actions = async (fixture: IClaudeFixture) => {
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const envelope = (command: IActionCommand): IActionEnvelope => ({
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command,
  });
  const submit = async (action: IActionEnvelope) => {
    const response = await fixture.request({ kind: 'action', action });
    if (response.kind !== 'action') throw new Error('Missing admission');
    return response.result;
  };
  const receipt = async (id: string) => {
    const response = await fixture.request({ kind: 'receipt', actionId: id });
    if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
    return response.result;
  };
  const thread = async (id: string): Promise<IManagedThread> => {
    const response = await fixture.request({ kind: 'managed-thread', threadId: id });
    if (response.kind !== 'managed-thread' || !response.result) throw new Error('Missing thread');
    return response.result;
  };
  const until = async <T>(
    read: () => Promise<T>,
    ready: (result: T) => boolean,
    timeout = 5000,
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    let result = await read();
    while (!ready(result) && Date.now() < deadline) {
      await wait(10);
      result = await read();
    }
    expect(ready(result), JSON.stringify(result)).toBe(true);
    return result;
  };
  const settled = (id: string) =>
    until(
      () => receipt(id),
      (result) => result.delivery === 'acknowledged',
    );
  const create = async (name = 'fix-login', provider: 'codex' | 'claude' = 'claude') => {
    const action = envelope({
      kind: 'thread-create',
      provider,
      workspaceRoot: fixture.workspaceRoot,
      name,
    });
    const admitted = await submit(action);
    await settled(action.id);
    return { action, thread: await thread(admitted.threadId!) };
  };
  const calls = async () =>
    (await readFile(join(fixture.root, 'claude-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            uuid?: string;
            request?: { subtype: string };
            response?: { request_id: string; response: unknown };
          },
      );
  const approvals = async (threadId: string) => {
    const response = await fixture.request({ kind: 'approvals', threadId });
    if (response.kind !== 'approvals') throw new Error('Missing approvals');
    return response.result;
  };
  const message = async (threadId: string, text = 'Please inspect this example') => {
    const action = envelope({ kind: 'message', threadId, input: { kind: 'text', text: text } });
    await submit(action);
    return action;
  };
  return {
    status,
    envelope,
    submit,
    receipt,
    thread,
    until,
    settled,
    create,
    calls,
    approvals,
    message,
  };
};

test('Claude creates and names an idle native session, deduplicates input and reconciles live items with native history', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const capabilities = await fixture.runtime.request({
      kind: 'capabilities',
      provider: 'claude',
    });
    expect(capabilities).toMatchObject({
      kind: 'capabilities',
      result: { operations: { steer: { state: 'unsupported' } } },
    });
    const created = await api.create();
    expect(created.thread).toMatchObject({ provider: 'claude', name: 'fix-login', state: 'idle' });
    expect((await api.submit(created.action)).threadId).toBe(created.thread.id);
    const starts = (await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.cwd).toBe(fixture.workspaceRoot);
    expect(starts[0]!.args).toContain('--permission-prompt-tool=stdio');
    expect(
      starts[0]!.args.some((arg) =>
        /bare|dangerously|permission-mode|settings|system-prompt|no-session-persistence/.test(arg),
      ),
    ).toBe(false);
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(0);
    const input = await api.message(created.thread.id);
    const done = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect(done.delivery).toBe('acknowledged');
    await api.submit(input);
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
    const live = await fixture.request({ kind: 'live-items', threadId: created.thread.id });
    expect(live.kind).toBe('live-items');
    if (live.kind !== 'live-items') throw new Error('Missing live items');
    expect(live.result.data).toHaveLength(2);
    expect(live.result.data.every((item) => !item.nativeId.startsWith('live:'))).toBe(true);
    const history = await fixture.request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: created.thread.nativeId!,
    });
    expect(history.kind).toBe('items');
    const reconciled = await fixture.request({ kind: 'live-items', threadId: created.thread.id });
    expect(reconciled).toMatchObject({ result: { data: [] } });
    const thread = await fixture.request({
      kind: 'thread',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: created.thread.nativeId!,
    });
    expect(thread).toMatchObject({
      result: { managedId: created.thread.id, ownership: 'managed' },
    });
  });
});

test('Claude queues one follow-up at a verified result boundary and never sends a duplicate', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ holdTurn: true });
    const first = await api.message(thread.id, 'First request');
    const accepted = await api.settled(first.id);
    const followUp = api.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      input: { kind: 'text', text: 'Next request' },
    });
    expect((await api.submit(followUp)).delivery).toBe('queued');
    await api.submit(followUp);
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
    await fixture.control({ release: true });
    await api.until(
      () => api.receipt(followUp.id),
      (entry) => entry.completion === 'completed',
    );
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(2);
  });
});

test('Claude interrupt acknowledgement does not complete the turn or dispatch queued input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ holdTurn: true, interruptDelay: 256 });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const queued = api.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      input: { kind: 'text', text: 'Follow up' },
    });
    await api.submit(queued);
    const stop = api.envelope({
      kind: 'interrupt',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
    });
    await api.submit(stop);
    await api.settled(stop.id);
    expect((await api.thread(thread.id)).state).toBe('stopping');
    expect((await api.receipt(input.id)).completion).toBeNull();
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'interrupted',
    );
    expect((await api.receipt(queued.id)).delivery).toBe('queued');
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
  });
});

test('Claude rejects steering and stale interruptions without substituting another action', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ holdTurn: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    await expectToRejectCode(
      fixture.runtime.request({
        kind: 'action',
        action: api.envelope({
          kind: 'steer',
          threadId: thread.id,
          expectedTurnId: accepted.nativeTurnId!,
          text: 'Change direction',
        }),
      }),
      'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
      'The HQ capability is unavailable',
    );
    const stale = await api.submit(
      api.envelope({ kind: 'interrupt', threadId: thread.id, expectedTurnId: 'different-turn' }),
    );
    expect(stale).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    expect((await api.calls()).some((call) => call.request?.subtype === 'interrupt')).toBe(false);
  });
});

test('Claude question replies are scope-checked, acknowledged by matching tool results and excluded from SQLite', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'question' });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    expect((await api.thread(thread.id)).state).toBe('waiting-input');
    const wrong = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'answers', answers: { Unknown: ['Red'] } },
    });
    await expectToRejectCode(
      api.submit(wrong),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      'Request is invalid.',
    );
    const answerText = 'private-answer-example-7ac49';
    const answer = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'answers', answers: { 'Which color?': [answerText] } },
    });
    await api.submit(answer);
    await api.settled(answer.id);
    await api.submit(answer);
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    const replies = (await api.calls()).filter((call) => call.type === 'control_response');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.response?.response).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which color?': answerText } },
    });
    const bytes = Buffer.concat(
      await Promise.all(
        ['hq.sqlite', 'hq.sqlite-wal'].map(async (filename) => {
          try {
            return await readFile(join(fixture.stateRoot, filename));
          } catch (cause) {
            if (filename.endsWith('-wal') && hasErrorCode(cause, 'ENOENT')) return Buffer.alloc(0);
            throw cause;
          }
        }),
      ),
    );
    expect(bytes.includes(Buffer.from('Which color?'))).toBe(false);
    expect(bytes.includes(Buffer.from(answerText))).toBe(false);
  });
});

test('Claude permissions preserve native input and cannot grant a session-wide approval', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'permission', toolFailure: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    expect(prompt).toMatchObject({ kind: 'permission', decisions: ['accept', 'decline'] });
    await expectToRejectCode(
      api.submit(
        api.envelope({
          kind: 'native-reply',
          threadId: thread.id,
          expectedTurnId: accepted.nativeTurnId!,
          approvalId: prompt!.id,
          response: { kind: 'decision', decision: 'acceptForSession' },
        }),
      ),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      'Request is invalid.',
    );
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'decision', decision: 'decline' },
    });
    await api.submit(reply);
    await api.settled(reply.id);
    expect(
      (await api.calls()).find((call) => call.type === 'control_response')!.response?.response,
    ).toMatchObject({ behavior: 'deny' });
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    expect(live).toMatchObject({
      kind: 'live-items',
      result: {
        data: expect.arrayContaining([
          expect.objectContaining({ kind: 'command', text: 'Tool failed' }),
        ]),
      },
    });
  });
});

test('Claude cancellation never acknowledges a written reply', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'question', cancelReply: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'answers', answers: { 'Which color?': ['Blue'] } },
    });
    await api.submit(reply);
    await api.until(
      () => api.receipt(reply.id),
      (entry) => entry.delivery === 'uncertain',
    );
    expect(await api.approvals(thread.id)).toStrictEqual([]);
    await api.submit(reply);
    expect((await api.calls()).filter((call) => call.type === 'control_response')).toHaveLength(1);
  });
});

test('identical native request IDs in different Claude processes cannot cross-answer sessions', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      left = await api.create('left-task'),
      right = await api.create('right-task');
    await fixture.control({ prompt: 'question', holdAfterReply: true });
    const inputs = await Promise.all([api.message(left.thread.id), api.message(right.thread.id)]);
    const accepted = await Promise.all(inputs.map((input) => api.settled(input.id)));
    const [leftPrompt] = await api.until(
      () => api.approvals(left.thread.id),
      (rows) => rows.length === 1,
    );
    const [rightPrompt] = await api.until(
      () => api.approvals(right.thread.id),
      (rows) => rows.length === 1,
    );
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: left.thread.id,
      expectedTurnId: accepted[0]!.nativeTurnId!,
      approvalId: leftPrompt!.id,
      response: { kind: 'answers', answers: { 'Which color?': ['Red'] } },
    });
    await api.submit(reply);
    await api.settled(reply.id);
    expect(await api.approvals(right.thread.id)).toHaveLength(1);
    await expect(
      api.submit(
        api.envelope({
          ...reply.command,
          kind: 'native-reply',
          threadId: left.thread.id,
          expectedTurnId: accepted[0]!.nativeTurnId!,
          approvalId: rightPrompt!.id,
          response: { kind: 'answers', answers: { 'Which color?': ['Red'] } },
        }),
      ),
    ).rejects.toThrow('State changed');
  });
});

test.each(['malformed', 'partial'])(
  'Claude %s output quarantines only its own controlled session and stops its process tree',
  async (mode) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture),
        good = await api.create('codex-task', 'codex'),
        broken = await api.create('claude-task');
      await fixture.control({ [mode]: true });
      const input = await api.message(broken.thread.id);
      await api.until(
        () => api.thread(broken.thread.id),
        (thread) => thread.ownership === 'uncertain',
      );
      expect((await api.receipt(input.id)).delivery).toBe('uncertain');
      expect((await api.thread(good.thread.id)).ownership).toBe('managed');
      const codexInput = await api.message(good.thread.id);
      await api.until(
        () => api.receipt(codexInput.id),
        (entry) => entry.completion === 'completed',
      );
    });
  },
);

test('Claude closed sessions resume explicitly with the same native identity and normal settings', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      created = await api.create();
    const first = await api.message(created.thread.id);
    await api.until(
      () => api.receipt(first.id),
      (entry) => entry.completion === 'completed',
    );
    const close = api.envelope({ kind: 'thread-close', threadId: created.thread.id });
    await api.submit(close);
    await api.settled(close.id);
    expect((await api.thread(created.thread.id)).state).toBe('inactive');
    const resume = api.envelope({
      kind: 'thread-resume',
      threadId: created.thread.id,
      operatorConfirmation: 'The other CLI controller is closed',
    });
    await api.submit(resume);
    await api.settled(resume.id);
    expect(await api.thread(created.thread.id)).toMatchObject({
      nativeId: created.thread.nativeId,
      state: 'idle',
    });
    const second = await api.message(created.thread.id);
    await api.until(
      () => api.receipt(second.id),
      (entry) => entry.completion === 'completed',
    );
    const starts = (await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(starts).toHaveLength(2);
    expect(starts[1]!.args).toContain('--resume');
  });
});

test('Claude external adoption requires qualified workspace history and an explicit handoff', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      nativeId = randomUUID();
    await writeFile(
      fixture.transcript(nativeId),
      JSON.stringify(claudeRecord(fixture.workspaceRoot, nativeId)) + '\n',
    );
    const browse = await fixture.request({
      kind: 'thread',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId,
    });
    expect(browse).toMatchObject({ result: { ownership: 'external', nativeState: 'unknown' } });
    expect(await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8')).toBe('');
    const adopt = api.envelope({
      kind: 'thread-adopt',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId,
      name: 'adopt-task',
      operatorConfirmation: 'I have closed the native CLI controller',
    });
    const admitted = await api.submit(adopt);
    await api.settled(adopt.id);
    expect(await api.thread(admitted.threadId!)).toMatchObject({
      nativeId,
      ownership: 'managed',
      state: 'idle',
    });
  });
});

test('Claude late input acknowledgement reconciles uncertainty without resending the text', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ lateAck: true });
    const input = await api.message(thread.id);
    const uncertain = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.delivery === 'uncertain',
      32000,
    );
    expect(uncertain.completion).toBeNull();
    await api.submit(input);
    const final = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect(final.delivery).toBe('acknowledged');
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
  });
}, 40000);

test.each([false, true])(
  'Claude question multi-select policy is visible and enforced (%s)',
  async (multiSelect) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture),
        { thread } = await api.create();
      await fixture.control({ prompt: 'question', multiSelect });
      const input = await api.message(thread.id),
        accepted = await api.settled(input.id);
      const [prompt] = await api.until(
        () => api.approvals(thread.id),
        (rows) => rows.length === 1,
      );
      expect(prompt!.questions[0]!.allowsMultiple).toBe(multiSelect);
      const answer = api.envelope({
        kind: 'native-reply',
        threadId: thread.id,
        expectedTurnId: accepted.nativeTurnId!,
        approvalId: prompt!.id,
        response: { kind: 'answers', answers: { 'Which color?': ['Red', 'Blue'] } },
      });
      if (multiSelect) {
        await api.submit(answer);
        await api.settled(answer.id);
        expect(
          (await api.calls()).find((call) => call.type === 'control_response')!.response?.response,
        ).toMatchObject({ updatedInput: { answers: { 'Which color?': 'Red, Blue' } } });
      } else
        await expectToRejectCode(
          api.submit(answer),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
          'Request is invalid.',
        );
    });
  },
);

test('Claude permission acceptance copies only the displayed native input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'permission' });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'decision', decision: 'accept' },
    });
    await api.submit(reply);
    await api.settled(reply.id);
    expect(
      (await api.calls()).find((call) => call.type === 'control_response')!.response?.response,
    ).toStrictEqual({ behavior: 'allow', updatedInput: { command: 'echo example' } });
  });
});

test('Claude late name acknowledgement reconciles its exact action and native name without a resend', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ lateName: true });
    const rename = api.envelope({
      kind: 'thread-rename',
      threadId: thread.id,
      name: 'review-login',
    });
    await api.submit(rename);
    await api.until(
      () => api.receipt(rename.id),
      (entry) => entry.delivery === 'uncertain',
      32000,
    );
    await api.submit(rename);
    await api.settled(rename.id);
    expect((await api.thread(thread.id)).name).toBe('review-login');
    expect(
      (await api.calls()).filter((call) => call.request?.subtype === 'rename_session'),
    ).toHaveLength(2);
  });
}, 40000);

test('canceling one Claude prompt preserves the wait state of another blocking prompt', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'question', doublePrompt: true, cancelReply: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const prompts = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 2,
    );
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompts[0]!.id,
      response: { kind: 'answers', answers: { 'Which color?': ['Red'] } },
    });
    await api.submit(reply);
    await api.until(
      () => api.receipt(reply.id),
      (entry) => entry.delivery === 'uncertain',
    );
    expect(await api.approvals(thread.id)).toHaveLength(1);
    expect((await api.thread(thread.id)).state).toBe('waiting-input');
  });
});

test('the same native ID in Claude and Codex retains separate control, history and live presentation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      claude = await api.create('claude-shared');
    const adopt = api.envelope({
      kind: 'thread-adopt',
      provider: 'codex',
      nativeId: claude.thread.nativeId!,
      workspaceRoot: fixture.workspaceRoot,
      name: 'codex-shared',
      operatorConfirmation: 'The Codex controller is closed',
    });
    const admitted = await api.submit(adopt);
    await api.settled(adopt.id);
    const codex = await api.thread(admitted.threadId!);
    expect(codex.nativeId).toBe(claude.thread.nativeId);
    expect(codex.id).not.toBe(claude.thread.id);
    const inputs = await Promise.all([api.message(claude.thread.id), api.message(codex.id)]);
    await Promise.all(
      inputs.map((input) =>
        api.until(
          () => api.receipt(input.id),
          (entry) => entry.completion === 'completed',
        ),
      ),
    );
    const claudeLive = await fixture.request({ kind: 'live-items', threadId: claude.thread.id });
    const codexLive = await fixture.request({ kind: 'live-items', threadId: codex.id });
    expect(claudeLive).toMatchObject({
      result: {
        data: expect.arrayContaining([
          expect.objectContaining({ text: 'Native response to Please inspect this example' }),
        ]),
      },
    });
    expect(codexLive).toMatchObject({
      result: { data: [expect.objectContaining({ text: 'Live response' })] },
    });
    const summaries = await Promise.all(
      (['claude', 'codex'] as const).map((provider) =>
        fixture.request({
          kind: 'thread',
          provider,
          workspaceRoot: fixture.workspaceRoot,
          nativeId: codex.nativeId!,
        }),
      ),
    );
    expect(summaries[0]).toMatchObject({
      result: { managedId: claude.thread.id, name: 'claude-shared' },
    });
    expect(summaries[1]).toMatchObject({ result: { managedId: codex.id, name: 'codex-shared' } });
  });
});

test.each([{ omitIdle: true }, { nativeState: 'running' }])(
  'unsupported Claude control capability fails closed (%o)',
  async (settings) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture);
      await fixture.control(settings);
      const action = api.envelope({
        kind: 'thread-create',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        name: 'blocked-task',
      });
      const admitted = await api.submit(action);
      await api.until(
        () => api.receipt(action.id),
        (entry) => entry.delivery === 'uncertain',
      );
      expect(await api.thread(admitted.threadId!)).toMatchObject({
        nativeId: null,
        state: 'unknown',
      });
      expect((await api.calls()).filter((call) => call.type === 'user')).toStrictEqual([]);
    });
  },
);

test('an exact Claude control rejection fails the action without claiming uncertain delivery', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ rejectName: true });
    const rename = api.envelope({
      kind: 'thread-rename',
      threadId: thread.id,
      name: 'rejected-name',
    });
    await api.submit(rename);
    const rejected = await api.until(
      () => api.receipt(rename.id),
      (entry) => entry.delivery === 'failed',
    );
    expect(rejected.failure).toBe('agent-unavailable');
    expect(await api.thread(thread.id)).toMatchObject({ state: 'idle', name: 'fix-login' });
  });
});

test('Claude displays the complete native permission scope before allowing it', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'permission', largeCommand: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    const command = 'echo ' + 'x'.repeat(16384) + ' visible-end';
    expect(JSON.parse(prompt!.detail)).toStrictEqual({ command });
    const reply = api.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      approvalId: prompt!.id,
      response: { kind: 'decision', decision: 'accept' },
    });
    await api.submit(reply);
    await api.settled(reply.id);
    expect(
      (await api.calls()).find((call) => call.type === 'control_response')!.response?.response,
    ).toStrictEqual({ behavior: 'allow', updatedInput: { command } });
  });
});

test('Claude completion wins an interruption race and its queued follow-up remains paused', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ holdTurn: true, completeOnInterrupt: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const queued = api.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      input: { kind: 'text', text: 'A paused follow-up' },
    });
    await api.submit(queued);
    const stop = api.envelope({
      kind: 'interrupt',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
    });
    await api.submit(stop);
    await api.settled(stop.id);
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect((await api.thread(thread.id)).state).toBe('completed');
    expect((await api.receipt(queued.id)).delivery).toBe('queued');
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
  });
});

test('Claude control checks native capabilities rather than rejecting a compatible version label', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    await fixture.control({ version: '2.1.305' });
    const { thread } = await api.create();
    const input = await api.message(thread.id);
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect(await api.thread(thread.id)).toMatchObject({ state: 'completed', ownership: 'managed' });
  });
});
