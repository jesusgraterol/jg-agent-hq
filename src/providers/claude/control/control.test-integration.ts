// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import type { IActionCommand, IActionEnvelope, IManagedThread } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../../../scripts/test-support/claude-runtime.js';
import {
  countHeldDelays,
  releaseHeldDelays,
  startHoldingDelays,
} from '../../../../scripts/test-support/delays.js';

import { createClaudeControl } from './control.js';

// the 60-minute idle period is released by the tests instead of waited out
vi.mock('jg-utilities', async (original) => {
  const actual = await original<typeof import('jg-utilities')>();
  const { holdDelays } = await import('../../../../scripts/test-support/delays.js');
  return { ...actual, delay: holdDelays(actual.delay) };
});
startHoldingDelays(3_600);

test.each(['missing', `${randomUUID()}:turn`, `${randomUUID()}:steer:steer`, 'not-a-uuid:steer'])(
  'Claude rejects an invalid internal steer request identity before opening a native session: %s',
  async (requestId) => {
    const control = createClaudeControl();
    await expectToRejectCode(
      control.steer(requestId, randomUUID(), randomUUID(), 'Exact input'),
      'JG_AGENT_HQ_ACTION_CONFLICT',
      'The HQ action conflicts with its recorded state',
    );
  },
);

const readStarts = async (fixture: IClaudeFixture) =>
  (await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => z.object({ id: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)));
const readPids = async (fixture: IClaudeFixture) =>
  (await readFile(join(fixture.root, 'claude-pids.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => z.object({ pid: z.number().int() }).parse(JSON.parse(line)).pid);
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// ends the idle period of every waiting session and waits until their processes are gone
const parkIdleSessions = async (fixture: IClaudeFixture, count = 1) => {
  await expect.poll(() => countHeldDelays(3_600)).toBe(count);
  const running = (await readPids(fixture)).filter(isRunning).length;
  expect(releaseHeldDelays(3_600)).toBe(count);
  await expect
    .poll(async () => (await readPids(fixture)).filter(isRunning).length)
    .toBe(running - count);
};

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
    const response = await fixture.request({ kind: 'approvals', threadId, state: 'pending' });
    if (response.kind !== 'approvals') throw new Error('Missing approvals');
    return response.result.data;
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
      result: { operations: { steer: { state: 'supported' } } },
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
        /bare|dangerously|permission-mode|settings|system-prompt|no-session-persistence|mcp-config/.test(
          arg,
        ),
      ),
    ).toBe(false);
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(0);
    // the answer streams and is saved while its result waits, so the window holds the final items
    await fixture.control({ holdResult: true });
    const input = await api.message(created.thread.id);
    const live = await api.until(
      () => fixture.request({ kind: 'live-items', threadId: created.thread.id }),
      (response) =>
        response.kind === 'live-items' &&
        response.result.data.filter((item) => item.state === 'awaiting-flush').length === 2,
    );
    if (live.kind !== 'live-items') throw new Error('Missing live items');
    expect(live.result.data).toHaveLength(2);
    expect(live.result.data.every((item) => !item.nativeId.startsWith('live:'))).toBe(true);
    await fixture.control({ holdResult: true, releaseResult: true });
    const done = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect(done.delivery).toBe('acknowledged');
    await api.submit(input);
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(1);
    // once the turn ends, its history holds both, and they leave the window without a client read
    await api.until(
      () => fixture.request({ kind: 'live-items', threadId: created.thread.id }),
      (response) => response.kind === 'live-items' && response.result.data.length === 0,
    );
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

test.each(['text', 'skill'] as const)(
  'Claude settings notices preserve exact acknowledgement and one live/saved input for %s messages',
  async (kind) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture);
      const { thread } = await api.create();
      const text = kind === 'text' ? 'Inspect the selected session' : '/explicit-skill inspect';
      const catalog = await fixture.request({
        kind: 'skills',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
      });
      const skill = catalog.result.data.find((entry) => entry.name === 'explicit-skill')!;
      for (let index = 0; index < 2; index += 1) {
        await fixture.control({ modelNotice: true, holdResult: true });
        const action = api.envelope({
          kind: 'message',
          threadId: thread.id,
          input:
            kind === 'text'
              ? { kind: 'text', text }
              : { kind: 'skill', skillId: skill.id, arguments: 'inspect' },
          settings: { model: 'model-0001' },
        });
        await api.submit(action);
        const accepted = await api.settled(action.id);
        expect(accepted.nativeTurnId).not.toBeNull();
        const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
        const inputs = live.result.data.filter(
          (item) => item.kind === 'user-message' && item.turnId === accepted.nativeTurnId,
        );
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({
          text,
          provenance: { actionId: action.id, nativeInputId: accepted.nativeTurnId },
        });
        await fixture.control({ modelNotice: true, holdResult: true, releaseResult: true });
        await api.until(
          () => api.receipt(action.id),
          (receipt) => receipt.completion === 'completed',
        );
        const saved = await fixture.request({
          kind: 'items',
          provider: 'claude',
          workspaceRoot: fixture.workspaceRoot,
          nativeId: thread.nativeId!,
          turnId: accepted.nativeTurnId!,
        });
        const savedInputs = saved.result.data.filter((item) => item.kind === 'user-message');
        expect(savedInputs).toHaveLength(1);
        expect(savedInputs[0]).toMatchObject({
          text,
          provenance: { actionId: action.id, nativeInputId: accepted.nativeTurnId },
        });
        expect(await api.thread(thread.id)).toMatchObject({
          ownership: 'managed',
          state: 'completed',
        });
      }
      expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(2);
    });
  },
);

test('Claude live items present what history will: thinking and notifications left out, a live edit as a file change', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const { thread } = await api.create();
    const [thinking, call, result, notification, answer] = Array.from({ length: 5 }, () =>
      randomUUID(),
    );
    const path = join(fixture.workspaceRoot, 'a.ts');
    const event = (body: unknown) => ({ type: 'stream_event', event: body });
    const script = {
      frames: [
        event({ type: 'message_start', message: { id: 'api-thinking' } }),
        event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        {
          type: 'assistant',
          uuid: thinking,
          message: {
            id: 'api-thinking',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
          },
        },
        event({ type: 'message_start', message: { id: 'api-edit' } }),
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} },
        }),
        {
          type: 'assistant',
          uuid: call,
          message: {
            id: 'api-edit',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: path } },
            ],
          },
        },
        {
          type: 'user',
          uuid: result,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'updated' }],
          },
          tool_use_result: {
            filePath: path,
            structuredPatch: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
            ],
          },
        },
        {
          type: 'user',
          uuid: notification,
          message: { role: 'user', content: '<task-notification>\n</task-notification>' },
        },
        {
          type: 'assistant',
          uuid: answer,
          message: {
            id: 'api-answer',
            role: 'assistant',
            content: [{ type: 'text', text: 'Edited.' }],
          },
        },
      ],
    };
    /*
     * the runtime clears a finished turn's live items once its saved history holds them, so
     * Claude's result waits until the live window has been read
     */
    await fixture.control({ ...script, holdResult: true });
    const input = await api.message(thread.id, 'Edit the file');
    await expect
      .poll(async () => {
        const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
        return live.result.data.map((item) => item.nativeId);
      })
      .toContain(answer);
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    await fixture.control({ ...script, holdResult: true, releaseResult: true });
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    const shown = (item: {
      nativeId: string;
      kind: string;
      text: string;
      callId: string | null;
      outcome: string | null;
      files: unknown[];
    }) => ({
      nativeId: item.nativeId,
      kind: item.kind,
      text: item.text,
      callId: item.callId,
      outcome: item.outcome,
      files: item.files,
    });
    const liveItems = live.result.data.map(shown);
    expect(liveItems.map((item) => item.nativeId)).toStrictEqual([
      expect.any(String),
      call,
      result,
      answer,
    ]);
    expect(liveItems[2]).toStrictEqual({
      nativeId: result,
      kind: 'file-change',
      text: `${path}\n@@ -1,1 +1,1 @@\n-old\n+new`,
      callId: 'toolu_edit',
      outcome: 'succeeded',
      files: [{ path, added: 1, removed: 1 }],
    });
    const history = await fixture.request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: thread.nativeId!,
    });
    if (history.kind !== 'items') throw new Error('Missing history');
    expect(history.result.data.map(shown).reverse()).toStrictEqual(liveItems);
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

test('Claude steers the running turn, which takes the text in and ends once, and refuses a stale steer or interrupt', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    // Claude takes the text in at the turn's next tool boundary, as it does for a tool-using turn
    await fixture.control({ holdTurn: true, steer: 'join' });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const steer = api.envelope({
      kind: 'steer',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      text: 'Also check the logout path',
    });
    steer.id = steer.id.toUpperCase();
    await api.submit(steer);
    expect(await api.settled(steer.id)).toMatchObject({ nativeTurnId: accepted.nativeTurnId });
    // the turn runs on, uninterrupted, with the text among its live items
    expect((await api.thread(thread.id)).activeTurnId).toBe(accepted.nativeTurnId);
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (live.kind !== 'live-items') throw new Error('Missing live items');
    expect(
      live.result.data
        .filter((item) => item.kind === 'user-message')
        .map(({ text, turnId }) => [text, turnId]),
    ).toContainEqual(['Also check the logout path', accepted.nativeTurnId]);
    const users = (await api.calls()).filter((call) => call.type === 'user');
    expect(users).toHaveLength(2);
    expect(users[1]!.uuid).toBe(steer.id);
    expect((await api.calls()).some((call) => call.request?.subtype === 'interrupt')).toBe(false);

    const stale = await api.submit(
      api.envelope({
        kind: 'steer',
        threadId: thread.id,
        expectedTurnId: 'different-turn',
        text: 'Too late',
      }),
    );
    expect(stale).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    const staleStop = await api.submit(
      api.envelope({ kind: 'interrupt', threadId: thread.id, expectedTurnId: 'different-turn' }),
    );
    expect(staleStop).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    expect((await api.calls()).filter((call) => call.type === 'user')).toHaveLength(2);

    await fixture.control({ release: true, steer: 'join' });
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect((await api.thread(thread.id)).activeTurnId).toBeNull();
  });
});

test("a Claude steer written while the turn's answer streams runs as the next turn, once the turn ends", async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    // Claude ends the turn first, then replays the text and answers it as a turn of its own
    await fixture.control({ holdTurn: true, steer: 'next' });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const steer = api.envelope({
      kind: 'steer',
      threadId: thread.id,
      expectedTurnId: accepted.nativeTurnId!,
      text: 'Add a summary at the end',
    });
    await api.submit(steer);
    expect((await api.receipt(steer.id)).delivery).not.toBe('acknowledged');

    await fixture.control({ release: true, steer: 'next' });
    // the steer is acknowledged against the turn it named, which completed as it was
    expect(await api.settled(steer.id)).toMatchObject({ nativeTurnId: accepted.nativeTurnId });
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    // the next turn answers the steer, and the session has no turn running once it ends
    const readHistory = async () => {
      const history = await fixture.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: thread.nativeId!,
      });
      if (history.kind !== 'items') throw new Error('Missing history');
      return history.result.data.map(({ kind, text, turnId }) => ({ kind, text, turnId }));
    };
    const [answer, asked] = await api.until(
      readHistory,
      ([newest]) => newest?.text.startsWith('Native response to Add a summary') ?? false,
    );
    expect([answer, asked]).toStrictEqual([
      {
        kind: 'agent-message',
        text: 'Native response to Add a summary at the end',
        turnId: asked!.turnId,
      },
      { kind: 'user-message', text: 'Add a summary at the end', turnId: asked!.turnId },
    ]);
    // a turn of its own, after the turn the steer named
    expect(asked!.turnId).not.toBe(accepted.nativeTurnId);
    const persisted = (
      await fixture.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: thread.nativeId!,
      })
    ).result.data.find((item) => item.nativeId === steer.id)!;
    expect(persisted.provenance).toMatchObject({
      actionId: steer.id,
      nativeInputId: steer.id,
      source: 'host-action',
      origin: 'unknown',
      grantsAuthority: false,
    });
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.activeTurnId === null && entry.state === 'completed',
    );
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
    // Claude's result waits until the live window has been read, before its turn's flush clears it
    await fixture.control({ prompt: 'permission', toolFailure: true, holdResult: true });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    expect(prompt).toMatchObject({
      kind: 'permission',
      presentation: { decisions: ['accept', 'decline'] },
    });
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
    await expect
      .poll(async () => (await fixture.request({ kind: 'live-items', threadId: thread.id })).result)
      .toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', text: 'Tool failed' }),
        ]),
      });
    await fixture.control({
      prompt: 'permission',
      toolFailure: true,
      holdResult: true,
      releaseResult: true,
    });
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion !== null,
    );
  });
});

test('Claude asks before running an MCP tool', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ prompt: 'permission', toolName: 'mcp__fixture-server__inspect' });
    await api.message(thread.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    expect(prompt).toMatchObject({
      kind: 'permission',
      presentation: { decisions: ['accept', 'decline'] },
    });
    expect((await api.calls()).some((call) => call.type === 'control_response')).toBe(false);
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

test('Claude external adoption requires qualified workspace history and an explicit handoff, and resumes with its settings', async () => {
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
      settings: { permissionMode: 'plan' },
    });
    const admitted = await api.submit(adopt);
    await api.settled(adopt.id);
    expect(await api.thread(admitted.threadId!)).toMatchObject({
      nativeId,
      ownership: 'managed',
      state: 'idle',
    });
    const [start] = await readStarts(fixture);
    expect(start!.args[start!.args.indexOf('--resume') + 1]).toBe(nativeId);
    expect(start!.args[start!.args.indexOf('--permission-mode') + 1]).toBe('plan');
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
      expect(prompt!.presentation!.questions[0]!.allowsMultiple).toBe(multiSelect);
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

test.each(['form', 'url'] as const)(
  'Claude %s elicitation requires explicit input and never invents a native acknowledgement',
  async (mode) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture),
        { thread } = await api.create();
      await fixture.control({
        prompt: 'permission',
        elicitation: {
          subtype: 'elicitation',
          mcp_server_name: 'fixture',
          mode,
          message: 'Choose a color',
          ...(mode === 'form'
            ? {
                requested_schema: {
                  type: 'object',
                  properties: { color: { type: 'string', enum: ['blue'] } },
                  required: ['color'],
                  additionalProperties: false,
                },
              }
            : { url: 'https://example.com/authorize', elicitation_id: 'native-elicit' }),
        },
      });
      await api.message(thread.id);
      const [prompt] = await api.until(
        () => api.approvals(thread.id),
        (rows) => rows.length === 1,
      );
      expect(prompt!.presentation?.elicitation).toMatchObject({ mode, serverName: 'fixture' });
      await expectToRejectCode(
        api.submit(
          api.envelope({
            kind: 'native-reply',
            threadId: thread.id,
            expectedTurnId: prompt!.nativeTurnId,
            approvalId: prompt!.id,
            response: { kind: 'decision', decision: 'accept' },
          }),
        ),
        'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      );
      const content = mode === 'form' ? { color: 'blue' } : null;
      const reply = api.envelope({
        kind: 'native-reply',
        threadId: thread.id,
        expectedTurnId: prompt!.nativeTurnId,
        approvalId: prompt!.id,
        response: { kind: 'elicitation', action: 'accept', content },
      });
      await api.submit(reply);
      await api.until(
        () => api.receipt(reply.id),
        (entry) => entry.delivery === 'uncertain',
      );
      expect(
        (await api.calls())
          .filter((call) => call.type === 'control_response')
          .map((call) => call.response?.response),
      ).toStrictEqual([{ action: 'accept', content }]);
      const history = await fixture.request({ kind: 'approvals', threadId: thread.id });
      expect(history).toMatchObject({
        result: { data: [{ state: 'expired', replyActionId: reply.id, presentation: null }] },
      });
      await api.submit(reply);
      expect((await api.calls()).filter((call) => call.type === 'control_response')).toHaveLength(
        1,
      );
    });
  },
);

test.each([{ requires_user_interaction: true }, { subtype: 'unknown-request' }])(
  'Claude does not turn unsupported native permission metadata %j into approval',
  async (permissionMetadata) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture),
        { thread } = await api.create();
      await fixture.control({ prompt: 'permission', permissionMetadata });
      await api.message(thread.id);
      await api.until(
        () => api.calls(),
        (calls) => calls.some((call) => call.type === 'control_response'),
      );
      expect(await api.approvals(thread.id)).toStrictEqual([]);
      expect(
        (await api.calls()).find((call) => call.type === 'control_response')?.response,
      ).toMatchObject({ subtype: 'error', error: "jg-agent-hq couldn't present this request" });
    });
  },
);

test('Claude permission acceptance copies only the displayed native input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({
      prompt: 'permission',
      permissionMetadata: {
        server_policy_ask_only: false,
        decision_reason_type: 'rule',
        decision_reason_rule_source: 'localSettings',
      },
    });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    expect((await api.calls()).filter((call) => call.type === 'control_response')).toStrictEqual(
      [],
    );
    expect(JSON.parse(prompt!.presentation!.detail)).toMatchObject({
      server_policy_ask_only: false,
      decision_reason_rule_source: 'localSettings',
    });
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

// the request's shape as Claude Code 2.1.316 sends it, with the fields it adds in some modes
test('Claude permission requests with fields this package does not list reach the operator', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({
      prompt: 'permission',
      permissionMetadata: {
        description: 'Write note.txt',
        display_name: 'Write',
        permission_suggestions: [],
        decision_reason_code: 'classifier_transcript_too_long',
        decision_reason_hook_event: 'PreToolUse',
        decision_reason_hook_source: 'userSettings',
        decision_reason_hook_plugin_id: 'example-plugin',
        tool_kind: 'browser',
      },
    });
    const input = await api.message(thread.id),
      accepted = await api.settled(input.id);
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    const detail = JSON.parse(prompt!.presentation!.detail);
    expect(detail).toMatchObject({ description: 'Write note.txt', display_name: 'Write' });
    expect(detail).not.toHaveProperty('decision_reason_code');
    expect(detail).not.toHaveProperty('tool_kind');
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
    // Claude's result waits until its live window has been read, before its turn's flush clears it
    await fixture.control({ holdResult: true });
    const inputs = await Promise.all([api.message(claude.thread.id), api.message(codex.id)]);
    await expect
      .poll(
        async () =>
          (await fixture.request({ kind: 'live-items', threadId: claude.thread.id })).result,
      )
      .toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ text: 'Native response to Please inspect this example' }),
        ]),
      });
    await fixture.control({ holdResult: true, releaseResult: true });
    await Promise.all(
      inputs.map((input) =>
        api.until(
          () => api.receipt(input.id),
          (entry) => entry.completion === 'completed',
        ),
      ),
    );
    const codexLive = await fixture.request({ kind: 'live-items', threadId: codex.id });
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
    expect(JSON.parse(prompt!.presentation!.detail)).toStrictEqual({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'tool-request',
      input: { command },
    });
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

test('an idle Claude session gives up its process after 60 minutes and answers reads, an interrupt and a stop without one', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const { thread } = await api.create();
    const input = await api.message(thread.id);
    const done = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    const transitions = async () => {
      const page = await fixture.request({ kind: 'session-states', limit: 128 });
      if (page.kind !== 'session-states') throw new Error('Missing transitions');
      return page.result.data;
    };
    const before = await transitions();
    const { state } = await api.thread(thread.id);
    await parkIdleSessions(fixture);
    expect((await api.thread(thread.id)).state).toBe(state);
    expect(
      await fixture.request({
        kind: 'skills',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
      }),
    ).toMatchObject({
      kind: 'skills',
      result: { state: 'available' },
    });
    expect(
      await fixture.request({
        kind: 'configuration',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
      }),
    ).toMatchObject({ kind: 'configuration', result: { effective: { model: 'model-0000' } } });
    // an interrupt is refused as any idle session's is
    expect(
      await api.submit(
        api.envelope({
          kind: 'interrupt',
          threadId: thread.id,
          expectedTurnId: done.nativeTurnId!,
        }),
      ),
    ).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    expect((await api.thread(thread.id)).state).toBe(state);
    expect(await transitions()).toStrictEqual(before);
    const close = api.envelope({ kind: 'thread-close', threadId: thread.id });
    await api.submit(close);
    await api.settled(close.id);
    expect((await api.thread(thread.id)).state).toBe('inactive');
    // nothing reopened the session
    expect(await readStarts(fixture)).toHaveLength(1);
  });
});

test.each([
  ['running', { holdTurn: true }, 'running'],
  ['waiting for its operator', { prompt: 'question' }, 'waiting-input'],
])('a Claude session %s never gives up its process', async (_label, control, state) => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const { thread } = await api.create();
    // a session's idle period starts when it opens, and its first turn ends that period
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    await fixture.control(control);
    const input = await api.message(thread.id);
    await api.settled(input.id);
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === state,
    );
    expect(countHeldDelays(3_600)).toBe(0);
    expect(releaseHeldDelays(3_600)).toBe(0);
    expect((await readPids(fixture)).every(isRunning)).toBe(true);
  });
});

test('a parked Claude session reopens for a message and a rename with its settings', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const create = api.envelope({
      kind: 'thread-create',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      name: 'parked-session',
      settings: {
        permissionMode: 'plan',
        systemInstructions: 'Answer briefly.',
        developerInstructions: 'Name the files you read.',
      },
    });
    const admitted = await api.submit(create);
    await api.settled(create.id);
    const thread = await api.thread(admitted.threadId!);
    const turn = async (text: string) => {
      const input = await api.message(thread.id, text);
      await api.until(
        () => api.receipt(input.id),
        (entry) => entry.completion === 'completed',
      );
    };
    await turn('First request');
    await parkIdleSessions(fixture);
    await turn('Second request');
    await parkIdleSessions(fixture);
    const rename = api.envelope({
      kind: 'thread-rename',
      threadId: thread.id,
      name: 'renamed-session',
    });
    await api.submit(rename);
    await api.settled(rename.id);
    expect((await api.thread(thread.id)).name).toBe('renamed-session');
    // every start passes the same flags
    const flags = (args: string[]) =>
      args
        .filter((_arg, index) => !['--session-id', '--resume'].includes(args[index - 1] ?? ''))
        .filter((arg) => arg !== '--session-id' && arg !== '--resume');
    const starts = await readStarts(fixture);
    expect(starts).toHaveLength(3);
    expect(starts[0]!.args).not.toContain('--mcp-config');
    expect(starts[0]!.args[starts[0]!.args.indexOf('--permission-mode') + 1]).toBe('plan');
    for (const start of starts.slice(1)) {
      expect(start.args[start.args.indexOf('--resume') + 1]).toBe(thread.nativeId);
      expect(flags(start.args)).toStrictEqual(flags(starts[0]!.args));
    }
  });
});

test('a parked Claude session reopens with the fast mode a message chose', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const { thread } = await api.create('fast-session');
    const input = api.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Answer quickly' },
      settings: { fast: true },
    });
    await api.submit(input);
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    await parkIdleSessions(fixture);
    const next = await api.message(thread.id, 'Second request');
    await api.until(
      () => api.receipt(next.id),
      (entry) => entry.completion === 'completed',
    );
    const starts = await readStarts(fixture);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.args).not.toContain('--settings');
    expect(starts[1]!.args[starts[1]!.args.indexOf('--settings') + 1]).toBe('{"fastMode":true}');
    const configuration = await fixture.request({
      kind: 'configuration',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      threadId: thread.id,
    });
    expect(configuration.kind === 'configuration' && configuration.result.effective.fast).toBe(
      true,
    );
  });
});

test('a Claude session reports its instructions only while its process started the conversation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const create = api.envelope({
      kind: 'thread-create',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      name: 'instructed-session',
      settings: {
        systemInstructions: 'Answer briefly.',
        developerInstructions: 'Name the files you read.',
      },
    });
    const admitted = await api.submit(create);
    await api.settled(create.id);
    const thread = await api.thread(admitted.threadId!);
    const instructions = async () => {
      const response = await fixture.request({
        kind: 'configuration',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
      });
      if (response.kind !== 'configuration') throw new Error('Missing configuration');
      const { systemInstructions, developerInstructions } = response.result.effective;
      return { systemInstructions, developerInstructions };
    };
    expect(await instructions()).toStrictEqual({
      systemInstructions: 'Answer briefly.',
      developerInstructions: 'Name the files you read.',
    });
    const turn = async (text: string) => {
      const input = await api.message(thread.id, text);
      await api.until(
        () => api.receipt(input.id),
        (entry) => entry.completion === 'completed',
      );
    };
    await turn('First request');
    // the first process still reports what it started with
    expect(await instructions()).toStrictEqual({
      systemInstructions: 'Answer briefly.',
      developerInstructions: 'Name the files you read.',
    });
    await parkIdleSessions(fixture);
    await turn('Second request');
    // the reopened process resumed the conversation, so Claude kept its recorded instructions
    expect((await readStarts(fixture)).at(-1)!.args).toContain('--resume');
    expect(await instructions()).toStrictEqual({
      systemInstructions: null,
      developerInstructions: null,
    });
  });
});

test('a parked Claude session keeps its controlled slot, so 32 processes never run beside it and it still reopens', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture);
    const { thread } = await api.create('parked-first');
    await parkIdleSessions(fixture);
    for (let index = 0; index < 31; index += 1) await api.create(`open-${index}`);
    expect(
      await api.submit(
        api.envelope({
          kind: 'thread-create',
          provider: 'claude',
          workspaceRoot: fixture.workspaceRoot,
          name: 'one-too-many',
        }),
      ),
    ).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    const input = await api.message(thread.id, 'Wake up');
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    expect(
      (await readStarts(fixture)).filter((start) => start.id === thread.nativeId),
    ).toHaveLength(2);
    expect((await readPids(fixture)).filter(isRunning)).toHaveLength(32);
  });
  // starting 32 native sessions, one after another, is legitimately slow
}, 120_000);

// waits for the turn Claude starts on its own and returns the ID HQ gave it
const awaitNativeTurn = async (api: Awaited<ReturnType<typeof actions>>, threadId: string) =>
  (
    await api.until(
      () => api.thread(threadId),
      (entry) => entry.state === 'running' && entry.activeTurnId !== null,
    )
  ).activeTurnId!;
const writtenInputs = async (api: Awaited<ReturnType<typeof actions>>) =>
  (await api.calls()).filter((call) => call.type === 'user');

test('a turn Claude starts on its own runs as session activity, streams live items and completes at its result', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeTurn: 'after-background-command', nativeHold: true });
    const turnId = await awaitNativeTurn(api, thread.id);
    // Claude sends no user frame for this turn, so HQ gives it an ID of its own
    expect(z.uuid().safeParse(turnId).success).toBe(true);
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    expect(live).toMatchObject({
      result: {
        data: expect.arrayContaining([
          expect.objectContaining({ turnId, kind: 'agent-message', text: 'Native follow-up' }),
        ]),
      },
    });
    await fixture.control({ nativeRelease: true });
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === 'completed' && entry.activeTurnId === null,
    );
    expect((await api.thread(thread.id)).ownership).toBe('managed');
    // the session stays available and takes input afterwards
    const input = await api.message(thread.id, 'Next request');
    expect(
      await api.until(
        () => api.receipt(input.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({
      completion: 'completed',
      result: { text: 'Native response to Next request' },
    });
  });
});

test('Stop interrupts a turn Claude started on its own and completes it as interrupted', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeTurn: 'after-background-command', nativeHold: true });
    const turnId = await awaitNativeTurn(api, thread.id);
    const stop = api.envelope({ kind: 'interrupt', threadId: thread.id, expectedTurnId: turnId });
    await api.submit(stop);
    await api.settled(stop.id);
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === 'interrupted' && entry.activeTurnId === null,
    );
    expect(
      (await api.calls()).filter((call) => call.request?.subtype === 'interrupt'),
    ).toHaveLength(1);
    await fixture.control({});
    const input = await api.message(thread.id, 'After the stop');
    expect(
      (
        await api.until(
          () => api.receipt(input.id),
          (entry) => entry.completion !== null,
        )
      ).completion,
    ).toBe('completed');
  });
});

test('input queued while a turn Claude started runs is delivered after that turn completes', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeTurn: 'after-background-command', nativeHold: true });
    const turnId = await awaitNativeTurn(api, thread.id);
    const queued = api.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: turnId,
      input: { kind: 'text', text: 'Follow up' },
    });
    expect((await api.submit(queued)).delivery).toBe('queued');
    expect(await writtenInputs(api)).toHaveLength(0);
    await fixture.control({ nativeRelease: true });
    expect(
      await api.until(
        () => api.receipt(queued.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({ completion: 'completed', result: { text: 'Native response to Follow up' } });
    expect(await writtenInputs(api)).toHaveLength(1);
  });
});

test('a message waiting for acknowledgement when Claude starts a turn of its own keeps its own turn, result and completion', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeBeforeReplay: true, holdTurn: true });
    const action = await api.message(thread.id, 'Waiting request');
    // Claude replays the input after its own turn, whose result is held by no receipt
    const acknowledged = await api.until(
      () => api.receipt(action.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const [written] = await writtenInputs(api);
    expect(acknowledged).toMatchObject({
      nativeTurnId: written!.uuid,
      completion: null,
      result: null,
    });
    expect((await api.thread(thread.id)).activeTurnId).toBe(written!.uuid);
    await fixture.control({ release: true });
    expect(
      await api.until(
        () => api.receipt(action.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({
      nativeTurnId: written!.uuid,
      completion: 'completed',
      result: { text: 'Native response to Waiting request' },
    });
  });
});

test('input written just before a turn Claude starts that outlasts the acknowledgement deadline is uncertain until its replay, then completes as its own turn', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeBeforeReplay: true, nativeTurnMs: 31_000 });
    const input = await api.message(thread.id, 'Early request');
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.delivery === 'uncertain',
      32_000,
    );
    const done = await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion !== null,
      8_000,
    );
    const [written] = await writtenInputs(api);
    expect(done).toMatchObject({
      delivery: 'acknowledged',
      nativeTurnId: written!.uuid,
      completion: 'completed',
      result: { text: 'Native response to Early request' },
    });
    expect(await api.thread(thread.id)).toMatchObject({
      ownership: 'managed',
      state: 'completed',
      activeTurnId: null,
    });
    expect(await writtenInputs(api)).toHaveLength(1);
  });
  // the turn Claude starts outlasts the 30-second acknowledgement deadline on purpose
}, 45_000);

test.each([false, true])(
  'a permission prompt during a turn Claude started reaches the operator under that turn, and its reply is written (input waiting: %s)',
  async (isInputWaiting) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await actions(fixture),
        { thread } = await api.create();
      await fixture.control(
        isInputWaiting
          ? { nativeBeforeReplay: true, nativePrompt: true }
          : { nativeTurn: 'after-background-command', nativePrompt: true },
      );
      const input = isInputWaiting ? await api.message(thread.id, 'Waiting request') : null;
      const [prompt] = await api.until(
        () => api.approvals(thread.id),
        (rows) => rows.length === 1,
      );
      const turnId = (await api.thread(thread.id)).activeTurnId;
      expect(prompt).toMatchObject({ kind: 'permission', nativeTurnId: turnId });
      if (input) expect(turnId).not.toBe((await writtenInputs(api))[0]!.uuid);
      const reply = api.envelope({
        kind: 'native-reply',
        threadId: thread.id,
        expectedTurnId: turnId!,
        approvalId: prompt!.id,
        response: { kind: 'decision', decision: 'accept' },
      });
      await api.submit(reply);
      await api.settled(reply.id);
      const written = (await api.calls()).find((call) => call.type === 'control_response');
      expect(written?.response).toMatchObject({
        request_id: 'native-turn-request',
        response: { behavior: 'allow' },
      });
      if (input)
        expect(
          await api.until(
            () => api.receipt(input.id),
            (entry) => entry.completion !== null,
          ),
        ).toMatchObject({
          completion: 'completed',
          result: { text: 'Native response to Waiting request' },
        });
      await api.until(
        () => api.thread(thread.id),
        (entry) => entry.state === 'completed' && entry.activeTurnId === null,
      );
    });
  },
);

test('a permission prompt left unanswered expires when the turn Claude started ends', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await fixture.control({ nativeTurn: 'after-background-command', nativePrompt: true });
    const [prompt] = await api.until(
      () => api.approvals(thread.id),
      (rows) => rows.length === 1,
    );
    await fixture.control({ nativeAbandonPrompt: true });
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === 'completed' && entry.activeTurnId === null,
    );
    expect(await api.approvals(thread.id)).toHaveLength(0);
    const expired = await fixture.request({
      kind: 'approvals',
      threadId: thread.id,
      state: 'expired',
    });
    expect(expired).toMatchObject({
      result: { data: [expect.objectContaining({ id: prompt!.id, state: 'expired' })] },
    });
    expect((await api.calls()).some((call) => call.type === 'control_response')).toBe(false);
  });
});

test('a Claude session that starts a turn of its own while it is being parked keeps its process', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    // Claude starts its turn while the park reads the session's settings
    await fixture.control({ nativeOnSettings: true, nativeHold: true });
    expect(releaseHeldDelays(3_600)).toBe(1);
    await awaitNativeTurn(api, thread.id);
    expect((await readPids(fixture)).every(isRunning)).toBe(true);
    await fixture.control({ nativeRelease: true });
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === 'completed' && entry.activeTurnId === null,
    );
    await parkIdleSessions(fixture);
  });
});

test('a Claude session keeps its process while a background command it started runs, shows it, and parks once none runs', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await actions(fixture),
      { thread } = await api.create();
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    await fixture.control({ backgroundTask: true });
    const input = await api.message(thread.id, 'Start a background command');
    await api.until(
      () => api.receipt(input.id),
      (entry) => entry.completion === 'completed',
    );
    // the session's live window shows the command while no turn runs
    const readBackground = async () => {
      const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
      if (live.kind !== 'live-items') throw new Error('Missing live items');
      return live.result.backgroundCommands;
    };
    await expect.poll(readBackground).toBe(1);
    // the session's summary carries the count, and it stays among the active sessions while idle
    const activeCount = async () => {
      const response = await fixture.request({ kind: 'active-sessions' });
      if (response.kind !== 'active-sessions') throw new Error('Missing active sessions');
      return (
        response.result.data.find((entry) => entry.managedId === thread.id)?.backgroundCommands ??
        null
      );
    };
    await expect.poll(activeCount).toBe(1);
    // the idle period that starts at the turn's end passes while the command still runs
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    expect(releaseHeldDelays(3_600)).toBe(1);
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    expect((await readPids(fixture)).every(isRunning)).toBe(true);
    // the command finishes, and Claude starts a turn of its own to report it
    await fixture.control({
      finishBackgroundTask: true,
      nativeTurn: 'after-background-command',
      nativeHold: true,
    });
    await awaitNativeTurn(api, thread.id);
    await expect.poll(readBackground).toBe(0);
    await fixture.control({ nativeRelease: true });
    await api.until(
      () => api.thread(thread.id),
      (entry) => entry.state === 'completed' && entry.activeTurnId === null,
    );
    // idle with nothing running, it is no longer active
    await expect.poll(activeCount).toBeNull();
    await parkIdleSessions(fixture);
  });
});
