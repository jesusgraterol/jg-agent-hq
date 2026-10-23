// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { createAgentHq, requestAgentHq, type IAgentHq } from 'jg-agent-hq';
import type {
  IActionCommand,
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
} from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { installCodexFixture, writeFixtureControl } from '../../scripts/test-support/index.js';

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-actions-'));
  const workspaceRoot = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  let runtime: IAgentHq | undefined;
  try {
    await mkdir(workspaceRoot);
    const bin = await installCodexFixture(root);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
    vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', workspaceRoot);
    runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('wrong response');
    const runtimeEpoch = status.result.runtimeEpoch;
    const request = (command: Parameters<typeof requestAgentHq>[1]) =>
      requestAgentHq(stateRoot, command);
    const envelope = (command: IActionCommand): IActionEnvelope => ({
      id: randomUUID(),
      runtimeEpoch,
      command,
    });
    const submit = async (action: IActionEnvelope): Promise<IActionReceipt> => {
      const response = await request({ kind: 'action', action });
      if (response.kind !== 'action') throw new Error('wrong response');
      return response.result;
    };
    const receipt = async (id: string): Promise<IActionReceipt> => {
      const response = await request({ kind: 'receipt', actionId: id });
      if (response.kind !== 'receipt' || !response.result) throw new Error('missing receipt');
      return response.result;
    };
    const thread = async (id: string): Promise<IManagedThread> => {
      const response = await request({ kind: 'managed-thread', threadId: id });
      if (response.kind !== 'managed-thread' || !response.result) throw new Error('missing thread');
      return response.result;
    };
    const until = async <T>(
      read: () => Promise<T>,
      ready: (result: T) => boolean,
      timeout = 3000,
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
    const create = async (name: string) => {
      const action = envelope({ kind: 'thread-create', provider: 'codex', workspaceRoot, name });
      const admitted = await submit(action);
      await until(
        () => receipt(action.id),
        (result) => result.delivery === 'acknowledged',
      );
      return { action, thread: await thread(admitted.threadId!) };
    };
    return {
      root,
      stateRoot,
      workspaceRoot,
      runtime,
      request,
      envelope,
      submit,
      receipt,
      thread,
      until,
      create,
      control: (settings: Record<string, unknown>) =>
        writeFixtureControl(root, 'control.json', settings),
      calls: async () =>
        (await readFile(join(root, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
      async close() {
        try {
          await runtime!.close();
          await rm(root, { recursive: true });
        } finally {
          vi.unstubAllEnvs();
        }
      },
    };
  } catch (error) {
    try {
      await runtime?.close();
      await rm(root, { recursive: true });
    } finally {
      vi.unstubAllEnvs();
    }
    throw error;
  }
};

test('atomic admission deduplicates UUIDs, suffixes names and rejects competing new turns', async () => {
  const fixture = await setup();
  try {
    const { action, thread } = await fixture.create('fix-login');
    expect((await fixture.submit(action)).delivery).toBe('acknowledged');
    await expectToRejectCode(
      fixture.submit({
        ...action,
        command: {
          ...action.command,
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'different-name',
        },
      }),
      'JG_AGENT_HQ_CLIENT_STATE_CONFLICT',
      'State changed. Refresh before continuing.',
    );
    await expectToRejectCode(
      fixture.runtime.request({
        kind: 'action',
        action: {
          ...action,
          command: {
            ...action.command,
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot: fixture.workspaceRoot,
            name: 'different-name',
          },
        },
      }),
      'JG_AGENT_HQ_ACTION_CONFLICT',
      'The HQ action conflicts with its recorded state',
    );
    const competing = await fixture.submit(
      fixture.envelope({
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        name: thread.name,
      }),
    );
    await fixture.until(
      () => fixture.receipt(competing.id),
      (receipt) => receipt.delivery === 'acknowledged',
    );
    expect((await fixture.thread(competing.threadId!)).name).toBe('fix-login-2');
    await fixture.control({ holdTurn: true });
    const first = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'First request' },
    });
    const second = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Competing request' },
    });
    const receipts = await Promise.all([fixture.submit(first), fixture.submit(second)]);
    expect(receipts.map((entry) => entry.delivery).sort()).toStrictEqual(['failed', 'submitted']);
    const admitted = receipts.find((entry) => entry.delivery === 'submitted')!;
    await fixture.until(
      () => fixture.receipt(admitted.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await fixture.submit(admitted.id === first.id ? first : second);
    const calls = await fixture.calls();
    expect(calls.filter((call) => call.method === 'thread/start')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'thread/start')!.params).toStrictEqual({
      cwd: fixture.workspaceRoot,
    });
  } finally {
    await fixture.close();
  }
});

test('steering stays bound to its active turn, while interrupt acknowledgement keeps the thread stopping', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('check-search');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Investigate search' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const stale = await fixture.submit(
      fixture.envelope({
        kind: 'steer',
        threadId: thread.id,
        expectedTurnId: 'different-turn',
        text: 'Wrong target',
      }),
    );
    expect(stale).toMatchObject({ delivery: 'failed', threadId: thread.id });
    const rejected = await fixture.request({ kind: 'actions', threadId: thread.id });
    if (rejected.kind !== 'actions') throw new Error('wrong response');
    expect(
      rejected.result.data.some((entry) => entry.id === stale.id && entry.delivery === 'failed'),
    ).toBe(true);
    const steer = await fixture.submit(
      fixture.envelope({
        kind: 'steer',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        text: 'Check keyboard input too',
      }),
    );
    await fixture.until(
      () => fixture.receipt(steer.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await fixture.control({ holdTurn: true, interruptDelay: 500 });
    const interrupt = await fixture.submit(
      fixture.envelope({
        kind: 'interrupt',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
      }),
    );
    await fixture.until(
      () => fixture.receipt(interrupt.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    expect((await fixture.thread(thread.id)).state).toBe('stopping');
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'interrupted',
    );
    expect((await fixture.receipt(interrupt.id)).completion).toBe('interrupted');
    const calls = await fixture.calls();
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('queued text cannot answer native questions; secret answers are absent from the durable ledger', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('review-form');
    await fixture.control({
      prompt: {
        method: 'item/tool/requestUserInput',
        params: {
          isBlocking: true,
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Select an example',
              isSecret: true,
              isOther: true,
              options: null,
            },
          ],
        },
      },
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Review the form' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'waiting-input',
    );
    const queued = await fixture.submit(
      fixture.envelope({
        kind: 'queue',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        input: { kind: 'text', text: 'Next task after the question' },
      }),
    );
    expect(queued).toMatchObject({ delivery: 'queued', nativeTurnId: null, completion: null });
    const prompts = await fixture.request({ kind: 'approvals', threadId: thread.id });
    if (prompts.kind !== 'approvals') throw new Error('wrong response');
    expect(prompts.result).toHaveLength(1);
    const answer = fixture.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: active.activeTurnId!,
      approvalId: prompts.result[0]!.id,
      response: { kind: 'answers', answers: { choice: ['fictional-answer-for-the-test'] } },
    });
    await fixture.control({ replyResolutionDelay: 500 });
    const reply = await fixture.submit(answer);
    expect(await fixture.request({ kind: 'approvals', threadId: thread.id })).toMatchObject({
      result: [{ replyActionId: reply.id, state: 'pending' }],
    });
    await fixture.until(
      () => fixture.receipt(reply.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    expect((await fixture.submit(answer)).delivery).toBe('acknowledged');
    await expect(fixture.submit({ ...answer, id: randomUUID() })).rejects.toThrow('State changed.');
    expect(
      (await readFile(join(fixture.root, 'replies.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
    expect((await fixture.receipt(queued.id)).delivery).toBe('queued');
    expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1);
    await fixture.runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      const saved = JSON.stringify(
        database.prepare('SELECT id, digest, queued_text FROM hq_action').all(),
      );
      expect(saved).not.toContain('fictional-answer-for-the-test');
      expect(saved).toContain('Next task after the question');
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test.each(['command', 'file-change'] as const)(
  'native %s approval stays bound to its offered decision and exact request',
  async (kind) => {
    const fixture = await setup();
    try {
      const { thread } = await fixture.create('approval-choice');
      const params =
        kind === 'command'
          ? {
              startedAtMs: Date.now(),
              command: 'node --version',
              cwd: fixture.workspaceRoot,
              availableDecisions: ['decline', 'cancel'],
            }
          : {
              startedAtMs: Date.now(),
              grantRoot: fixture.workspaceRoot,
              reason: 'Write the selected example file',
            };
      await fixture.control({
        prompt: {
          method:
            kind === 'command'
              ? 'item/commandExecution/requestApproval'
              : 'item/fileChange/requestApproval',
          params,
        },
      });
      await fixture.submit(
        fixture.envelope({
          kind: 'message',
          threadId: thread.id,
          input: { kind: 'text', text: 'Inspect the native approval' },
        }),
      );
      const active = await fixture.until(
        () => fixture.thread(thread.id),
        (entry) => entry.state === 'waiting-approval',
      );
      const response = await fixture.request({ kind: 'approvals', threadId: thread.id });
      if (response.kind !== 'approvals') throw new Error('wrong response');
      const approval = response.result[0]!;
      expect(approval.kind).toBe(kind);
      expect(approval.decisions).toStrictEqual(
        kind === 'command'
          ? ['decline', 'cancel']
          : ['accept', 'acceptForSession', 'decline', 'cancel'],
      );
      if (kind === 'command')
        await expectToRejectCode(
          fixture.submit(
            fixture.envelope({
              kind: 'native-reply',
              threadId: thread.id,
              expectedTurnId: active.activeTurnId!,
              approvalId: approval.id,
              response: { kind: 'decision', decision: 'accept' },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
          'Request is invalid.',
        );
      const decision = kind === 'command' ? 'decline' : 'accept';
      const reply = await fixture.submit(
        fixture.envelope({
          kind: 'native-reply',
          threadId: thread.id,
          expectedTurnId: active.activeTurnId!,
          approvalId: approval.id,
          response: { kind: 'decision', decision },
        }),
      );
      await fixture.until(
        () => fixture.receipt(reply.id),
        (entry) => entry.delivery === 'acknowledged',
      );
      const replies = (await readFile(join(fixture.root, 'replies.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(replies).toStrictEqual([{ id: 'native-approval-1', result: { decision } }]);
    } finally {
      await fixture.close();
    }
  },
);

test('a normal completion advances queued work once; interruption pauses the queue until explicit selection', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('test-queue');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'First task' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const queued = await fixture.submit(
      fixture.envelope({
        kind: 'queue',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        input: { kind: 'text', text: 'Second task' },
      }),
    );
    await fixture.control({
      holdTurn: true,
      emit: [
        {
          method: 'turn/completed',
          params: {
            threadId: thread.nativeId,
            turn: { id: active.activeTurnId, status: 'completed' },
          },
        },
      ],
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await fixture.control({ holdTurn: true });
    await fixture.until(
      () => fixture.receipt(queued.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const second = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running' && entry.activeTurnId !== active.activeTurnId,
    );
    expect(await fixture.receipt(queued.id)).toMatchObject({
      delivery: 'acknowledged',
      nativeTurnId: second.activeTurnId,
      completion: null,
    });
    const paused = await fixture.submit(
      fixture.envelope({
        kind: 'queue',
        threadId: thread.id,
        expectedTurnId: second.activeTurnId!,
        input: { kind: 'text', text: 'Third task' },
      }),
    );
    await fixture.submit(
      fixture.envelope({
        kind: 'interrupt',
        threadId: thread.id,
        expectedTurnId: second.activeTurnId!,
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'interrupted',
    );
    expect((await fixture.receipt(paused.id)).delivery).toBe('queued');
    const send = fixture.envelope({ kind: 'queue-send', queuedActionId: paused.id });
    await fixture.submit(send);
    await fixture.until(
      () => fixture.receipt(paused.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await fixture.submit(send);
    expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(3);
  } finally {
    await fixture.close();
  }
});

test('live items remain available through native flush; lifecycle replay is bounded and ordered', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('live-history');
    const action = await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Say hello' },
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'completed',
    );
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    expect(live).toMatchObject({
      kind: 'live-items',
      result: { data: [{ text: 'Live response', state: 'awaiting-flush' }], hasGap: false },
    });
    await fixture.control({ awaitingFlush: true });
    await fixture.request({
      kind: 'items',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: thread.nativeId!,
    });
    expect(await fixture.request({ kind: 'live-items', threadId: thread.id })).toStrictEqual(live);
    const close = await fixture.submit(
      fixture.envelope({ kind: 'thread-close', threadId: thread.id }),
    );
    await fixture.until(
      () => fixture.receipt(close.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    expect(await fixture.request({ kind: 'live-items', threadId: thread.id })).toStrictEqual(live);
    await fixture.control({
      items: [
        {
          turnId: 'native-turn-1',
          item: { id: 'live-1', type: 'agentMessage', text: 'Live response' },
        },
      ],
    });
    await fixture.request({
      kind: 'items',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: thread.nativeId!,
    });
    expect(await fixture.request({ kind: 'live-items', threadId: thread.id })).toMatchObject({
      result: { data: [] },
    });
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const response = await fixture.request({
        kind: 'events',
        threadId: thread.id,
        after,
        limit: 2,
      });
      if (response.kind !== 'events') throw new Error('wrong response');
      expect(response.result.data.length).toBeLessThanOrEqual(2);
      seen.push(...response.result.data.map((event) => event.sequence));
      if (!response.result.hasMore) break;
      after = response.result.data.at(-1)!.sequence;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toStrictEqual([...seen].sort((left, right) => left - right));
    expect((await fixture.receipt(action.id)).completion).toBe('completed');
  } finally {
    await fixture.close();
  }
});

test('native-session adoption is exclusive and stale epochs cannot create another controller action', async () => {
  const fixture = await setup();
  try {
    const actions = ['adopt-one', 'adopt-two'].map((name) =>
      fixture.envelope({
        kind: 'thread-adopt',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: 'external-thread',
        name,
        operatorConfirmation: 'The native CLI session has been closed',
      }),
    );
    const results = await Promise.all(actions.map(fixture.submit));
    expect(results.map((entry) => entry.delivery).sort()).toStrictEqual(['failed', 'submitted']);
    const winner = results.find((entry) => entry.delivery === 'submitted')!;
    await fixture.until(
      () => fixture.receipt(winner.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const stale = fixture.envelope({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name: 'stale-epoch',
    });
    stale.runtimeEpoch = randomUUID();
    await expect(fixture.submit(stale)).rejects.toThrow('State changed.');
    expect((await fixture.calls()).filter((call) => call.method === 'thread/resume')).toHaveLength(
      1,
    );
    expect((await fixture.calls()).filter((call) => call.method === 'thread/start')).toHaveLength(
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('completion while steering cannot silently start a replacement turn or resurrect the finished turn', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('steer-race');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Check the implementation' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    await fixture.control({ completeOnSteer: true });
    const steer = await fixture.submit(
      fixture.envelope({
        kind: 'steer',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        text: 'One more detail',
      }),
    );
    await fixture.until(
      () => fixture.receipt(steer.id),
      (entry) => entry.delivery === 'failed',
    );
    expect(await fixture.thread(thread.id)).toMatchObject({
      state: 'completed',
      activeTurnId: null,
    });
    expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('unknown permission fields fail closed; supported permission replies grant only the displayed scope', async () => {
  const fixture = await setup();
  try {
    const first = (await fixture.create('unknown-permission')).thread;
    await fixture.control({
      prompt: {
        method: 'item/permissions/requestApproval',
        params: {
          startedAtMs: Date.now(),
          cwd: fixture.workspaceRoot,
          permissions: { unexpectedScope: true },
        },
      },
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: first.id,
        input: { kind: 'text', text: 'Check a permission request' },
      }),
    );
    await fixture.until(
      async () => {
        try {
          return await readFile(join(fixture.root, 'replies.jsonl'), 'utf8');
        } catch {
          return '';
        }
      },
      (text) => text.includes('Unsupported request'),
    );
    expect(await fixture.request({ kind: 'approvals', threadId: first.id })).toStrictEqual({
      kind: 'approvals',
      result: [],
    });
    const second = (await fixture.create('known-permission')).thread;
    const permissions = {
      fileSystem: { read: [fixture.workspaceRoot] },
      network: { enabled: false },
    };
    await fixture.control({
      prompt: {
        method: 'item/permissions/requestApproval',
        params: { startedAtMs: Date.now(), cwd: fixture.workspaceRoot, permissions },
      },
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: second.id,
        input: { kind: 'text', text: 'Read the selected workspace' },
      }),
    );
    await fixture.until(
      () => fixture.thread(second.id),
      (entry) => entry.state === 'waiting-approval',
    );
    const result = await fixture.request({ kind: 'approvals', threadId: second.id });
    if (result.kind !== 'approvals') throw new Error('wrong response');
    const approval = result.result[0]!;
    expect(JSON.parse(approval.detail).permissions).toStrictEqual(permissions);
    await expectToRejectCode(
      fixture.submit(
        fixture.envelope({
          kind: 'native-reply',
          threadId: second.id,
          expectedTurnId: approval.nativeTurnId,
          approvalId: approval.id,
          response: { kind: 'answers', answers: { choice: ['example'] } },
        }),
      ),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      'Request is invalid.',
    );
    const reply = await fixture.submit(
      fixture.envelope({
        kind: 'native-reply',
        threadId: second.id,
        expectedTurnId: approval.nativeTurnId,
        approvalId: approval.id,
        response: { kind: 'permission', decision: 'accept', scope: 'turn' },
      }),
    );
    await fixture.until(
      () => fixture.receipt(reply.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const replies = (await readFile(join(fixture.root, 'replies.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies.at(-1).result).toStrictEqual({ permissions, scope: 'turn' });
  } finally {
    await fixture.close();
  }
});

test('native output loss keeps delivery uncertain and restart never resends its original message', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('lost-ack');
    await fixture.control({ loseOutput: true, holdTurn: true });
    const action = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'A message with an unknown outcome' },
    });
    await fixture.submit(action);
    await fixture.until(
      () => fixture.receipt(action.id),
      (entry) => entry.delivery === 'uncertain',
    );
    expect(await fixture.thread(thread.id)).toMatchObject({
      ownership: 'uncertain',
      state: 'unknown',
    });
    const events = await fixture.request({ kind: 'events', threadId: thread.id, limit: 128 });
    if (events.kind !== 'events') throw new Error('wrong response');
    expect(events.result.data.some((event) => event.kind === 'native-unavailable')).toBe(true);
    await fixture.submit(action);
    await fixture.runtime.close();
    await fixture.control({});
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect((await fixture.submit(action)).delivery).toBe('uncertain');
      const status = await restarted.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('wrong response');
      expect(status.result.runtimeEpoch).not.toBe(action.runtimeEpoch);
      const receipt = await restarted.request({ kind: 'receipt', actionId: action.id });
      expect(receipt).toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain' } });
      expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(
        1,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.close();
  }
});

test(
  'an exact late acknowledgement reconciles an uncertain send without replaying it',
  { timeout: 40_000 },
  async () => {
    const fixture = await setup();
    try {
      const { thread } = await fixture.create('late-ack');
      await fixture.control({ lateTurnAck: true });
      const action = fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Wait for the original acknowledgement' },
      });
      await fixture.submit(action);
      await fixture.until(
        () => fixture.receipt(action.id),
        (entry) => entry.delivery === 'uncertain',
        30_500,
      );
      await fixture.submit(action);
      const acknowledged = await fixture.until(
        () => fixture.receipt(action.id),
        (entry) => entry.delivery === 'acknowledged',
        3000,
      );
      expect(acknowledged.completion).toBe('completed');
      expect(await fixture.thread(thread.id)).toMatchObject({
        state: 'completed',
        activeTurnId: null,
      });
      expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(
        1,
      );
    } finally {
      await fixture.close();
    }
  },
);

test.each(['notLoaded', 'idle'])(
  'rename, close and explicit resume retain the HQ identity when native state is %s',
  async (unsubscribeState) => {
    const fixture = await setup();
    try {
      await fixture.control({ unsubscribeState });
      const { thread } = await fixture.create('inspect-api');
      const rename = await fixture.submit(
        fixture.envelope({ kind: 'thread-rename', threadId: thread.id, name: 'fix-api' }),
      );
      await fixture.until(
        () => fixture.receipt(rename.id),
        (entry) => entry.delivery === 'acknowledged',
      );
      expect(await fixture.thread(thread.id)).toMatchObject({
        id: thread.id,
        name: 'fix-api',
        nativeId: thread.nativeId,
      });
      expect(
        await fixture.request({
          kind: 'thread',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          nativeId: thread.nativeId!,
        }),
      ).toMatchObject({ result: { ownership: 'managed', managedId: thread.id, name: 'fix-api' } });
      const close = await fixture.submit(
        fixture.envelope({ kind: 'thread-close', threadId: thread.id }),
      );
      await fixture.until(
        () => fixture.receipt(close.id),
        (entry) => entry.delivery === 'acknowledged',
      );
      expect(await fixture.thread(thread.id)).toMatchObject({
        state: 'inactive',
        runtimeEpoch: null,
      });
      const resume = await fixture.submit(
        fixture.envelope({
          kind: 'thread-resume',
          threadId: thread.id,
          operatorConfirmation: 'This native thread is closed in other CLIs',
        }),
      );
      await fixture.until(
        () => fixture.receipt(resume.id),
        (entry) => entry.delivery === 'acknowledged',
      );
      expect(await fixture.thread(thread.id)).toMatchObject({
        id: thread.id,
        nativeId: thread.nativeId,
        state: 'idle',
      });
      const calls = (await fixture.calls()).map((call) => call.method);
      expect(calls.indexOf('thread/backgroundTerminals/clean')).toBeLessThan(
        calls.indexOf('thread/backgroundTerminals/list'),
      );
      expect(calls.indexOf('thread/backgroundTerminals/list')).toBeLessThan(
        calls.indexOf('thread/unsubscribe'),
      );
    } finally {
      await fixture.close();
    }
  },
);

test('explicit resume cannot acquire an active native thread or an already controlled idle thread', async () => {
  const fixture = await setup();
  try {
    await fixture.control({ unsubscribeState: 'active' });
    const { thread } = await fixture.create('resume-guard');
    const command = {
      kind: 'thread-resume' as const,
      threadId: thread.id,
      operatorConfirmation: 'No other CLI controller owns this task-owned session',
    };
    await expectToRejectCode(
      fixture.submit(fixture.envelope(command)),
      'JG_AGENT_HQ_CLIENT_STATE_CONFLICT',
      'State changed. Refresh before continuing.',
    );
    const close = await fixture.submit(
      fixture.envelope({ kind: 'thread-close', threadId: thread.id }),
    );
    await fixture.until(
      () => fixture.receipt(close.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await expectToRejectCode(
      fixture.submit(fixture.envelope(command)),
      'JG_AGENT_HQ_CLIENT_STATE_CONFLICT',
      'State changed. Refresh before continuing.',
    );
    expect((await fixture.calls()).filter((call) => call.method === 'thread/resume')).toHaveLength(
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('control seek pages preserve tied ordering, reject changed filters and omit queued bodies', async () => {
  const fixture = await setup();
  try {
    const first = (await fixture.create('page-one')).thread;
    await fixture.create('page-two');
    const initial = await fixture.request({
      kind: 'managed-threads',
      workspaceRoot: fixture.workspaceRoot,
      limit: 1,
    });
    if (initial.kind !== 'managed-threads') throw new Error('wrong response');
    expect(initial.result.data).toHaveLength(1);
    const next = await fixture.request({
      kind: 'managed-threads',
      workspaceRoot: fixture.workspaceRoot,
      limit: 1,
      cursor: initial.result.nextCursor!,
    });
    if (next.kind !== 'managed-threads') throw new Error('wrong response');
    expect(next.result.data).toHaveLength(1);
    expect(next.result.data[0]!.id).not.toBe(initial.result.data[0]!.id);
    expect(next.result.nextCursor).toBeNull();
    await expectToRejectCode(
      fixture.request({
        kind: 'managed-threads',
        workspaceRoot: fixture.workspaceRoot,
        limit: 2,
        cursor: initial.result.nextCursor!,
      }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      'Request is invalid.',
    );
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: first.id,
        input: { kind: 'text', text: 'First paged task' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(first.id),
      (entry) => entry.state === 'running',
    );
    const queued = await fixture.submit(
      fixture.envelope({
        kind: 'queue',
        threadId: first.id,
        expectedTurnId: active.activeTurnId!,
        input: { kind: 'text', text: 'A selected queue body' },
      }),
    );
    const actions = await fixture.request({ kind: 'actions', threadId: first.id, limit: 128 });
    expect(JSON.stringify(actions)).not.toContain('A selected queue body');
    expect((await fixture.receipt(queued.id)).queuedText).toBe('A selected queue body');
    const cancel = await fixture.submit(
      fixture.envelope({ kind: 'queue-cancel', queuedActionId: queued.id }),
    );
    expect(cancel.delivery).toBe('acknowledged');
    expect(await fixture.receipt(queued.id)).toMatchObject({
      delivery: 'canceled',
      queuedText: null,
    });
  } finally {
    await fixture.close();
  }
});

test('large live windows bound serialized output, expose gaps and truncate text without splitting characters', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('bounded-live');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Keep the live turn open' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const emit = async (events: { method: string; params: object }[]) => {
      await fixture.control({ holdTurn: true, emit: events });
      await fixture.request({ kind: 'usage', provider: 'codex' });
      await fixture.control({ holdTurn: true });
      await wait(10);
    };
    for (let offset = 0; offset < 130; offset += 16) {
      await emit(
        Array.from({ length: Math.min(16, 130 - offset) }, (_, index) => ({
          method: 'item/completed',
          params: {
            threadId: thread.nativeId,
            turnId: active.activeTurnId,
            item: { id: `bounded-${offset + index}`, type: 'agentMessage', text: 'Small item' },
          },
        })),
      );
    }
    const bounded = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (bounded.kind !== 'live-items') throw new Error('wrong response');
    expect(bounded.result.data).toHaveLength(128);
    expect(bounded.result.hasGap).toBe(true);
    await emit(
      Array.from({ length: 16 }, (_, index) => ({
        method: 'item/completed',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          item: { id: `escaped-${index}`, type: 'agentMessage', text: '\u0001'.repeat(65_536) },
        },
      })),
    );
    const large = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (large.kind !== 'live-items') throw new Error('wrong response');
    expect(large.result.data.length).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(4 * 1024 * 1024 + 1024);
    expect(large.result.hasGap).toBe(true);
    await emit([
      {
        method: 'item/started',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          item: { id: 'unicode-item', type: 'agentMessage', text: '' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          itemId: 'unicode-item',
          delta: '😀'.repeat(40_000),
        },
      },
    ]);
    const unicode = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (unicode.kind !== 'live-items') throw new Error('wrong response');
    const item = unicode.result.data.find((entry) => entry.nativeId === 'unicode-item')!;
    expect(item.isTruncated).toBe(true);
    expect(item.text).toBe('😀'.repeat(32_768));
  } finally {
    await fixture.close();
  }
});

test('shutdown waits for admission and cannot start inference after native cleanup', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('shutdown-race');
    const action = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Race shutdown' },
    });
    const pending = fixture.runtime.request({ kind: 'action', action });
    const stopped = fixture.runtime.close();
    const outcome = await Promise.allSettled([pending, stopped]);
    expect(outcome[1]!.status).toBe('fulfilled');
    const calls = (await fixture.calls()).map((call) => call.method);
    const firstCleanup = calls.indexOf('thread/backgroundTerminals/clean');
    const turn = calls.indexOf('turn/start');
    expect(turn === -1 || turn < firstCleanup).toBe(true);
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      const saved = database
        .prepare('SELECT state, runtime_epoch FROM hq_thread WHERE id = ?')
        .get(thread.id);
      expect(saved).toMatchObject({ state: 'inactive', runtime_epoch: null });
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test('shutdown interrupts every active session before waiting for their individual acknowledgements', async () => {
  const fixture = await setup();
  try {
    await fixture.control({ holdTurn: true });
    for (const name of ['stop-one', 'stop-two', 'stop-three', 'stop-four']) {
      const { thread } = await fixture.create(name);
      await fixture.submit(
        fixture.envelope({
          kind: 'message',
          threadId: thread.id,
          input: { kind: 'text', text: 'Keep this turn active' },
        }),
      );
      await fixture.until(
        () => fixture.thread(thread.id),
        (entry) => entry.state === 'running',
      );
    }
    // The external fixture withholds each acknowledgement until all four sessions receive interruption.
    await fixture.control({ holdTurn: true, interruptBarrier: 4 });
    await fixture.runtime.close();
    const calls = (await fixture.calls()).map((call) => call.method);
    expect(calls.filter((method) => method === 'turn/interrupt')).toHaveLength(4);
    expect(calls.lastIndexOf('turn/interrupt')).toBeLessThan(
      calls.indexOf('thread/backgroundTerminals/clean'),
    );
  } finally {
    await fixture.close();
  }
});

test.each([
  'overflow',
  'malformed-turn',
  'malformed-item',
  'malformed-delta',
  'malformed-resolution',
  'contradictory-completion',
])('%s native events stop control and preserve explicit uncertain ownership', async (scenario) => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('event-overflow');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Keep the turn open' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const malformed: Record<string, { method: string; params: unknown }> = {
      'malformed-turn': {
        method: 'turn/completed',
        params: { threadId: thread.nativeId, turn: { status: 'completed' } },
      },
      'malformed-item': {
        method: 'item/completed',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          item: { type: 'agentMessage', text: 'Missing identity' },
        },
      },
      'malformed-delta': {
        method: 'item/agentMessage/delta',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          itemId: 'invalid-delta',
          delta: 42,
        },
      },
      'malformed-resolution': {
        method: 'serverRequest/resolved',
        params: { threadId: thread.nativeId, requestId: null },
      },
      'contradictory-completion': {
        method: 'turn/completed',
        params: {
          threadId: thread.nativeId,
          turn: { id: active.activeTurnId, status: 'inProgress' },
        },
      },
    };
    await fixture.control({
      holdTurn: true,
      emit:
        scenario === 'overflow'
          ? Array.from({ length: 2048 }, (_, index) => ({
              method: 'item/completed',
              params: {
                threadId: thread.nativeId,
                turnId: active.activeTurnId,
                item: { id: `overflow-${index}`, type: 'agentMessage', text: 'item' },
              },
            }))
          : [malformed[scenario]],
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'unknown' && entry.ownership === 'uncertain',
    );
    await expectToRejectCode(
      fixture.submit(
        fixture.envelope({
          kind: 'steer',
          threadId: thread.id,
          expectedTurnId: active.activeTurnId!,
          text: 'Cannot continue after a gap',
        }),
      ),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
    if (scenario === 'overflow') {
      await expectToRejectCode(
        fixture.runtime.close(),
        'JG_AGENT_HQ_TRANSPORT_FAILED',
        'The Codex integration failed',
      );
      expect(await readFile(join(fixture.stateRoot, 'hq-owner.json'), 'utf8')).toContain('serve');
    } else {
      await fixture.runtime.close();
      await expect(readFile(join(fixture.stateRoot, 'hq-owner.json'))).rejects.toThrow('ENOENT');
    }
  } finally {
    // This scenario deliberately retains the owner after an observed failure. Remove only the disposable fixture after proving native exit.
    await fixture.runtime.close().catch(() => undefined);
    try {
      const pids = z
        .object({ parent: z.number().int().positive(), child: z.number().int().positive() })
        .parse(JSON.parse(await readFile(join(fixture.root, 'pids.json'), 'utf8')));
      for (const pid of [pids.parent, pids.child]) {
        let stopped = false;
        try {
          process.kill(pid, 0);
        } catch (error) {
          stopped = hasErrorCode(error, 'ESRCH');
        }
        expect(stopped).toBe(true);
      }
      await rm(fixture.root, { recursive: true });
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

test('a ledger read failure during shutdown still stops the owned native process group', async () => {
  const fixture = await setup();
  try {
    await fixture.create('failed-store');
    // Deliberately corrupt only this disposable fixture to provoke a real worker read failure.
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), {
      enableForeignKeyConstraints: false,
    });
    try {
      database.exec('DROP TABLE hq_thread');
    } finally {
      database.close();
    }
    await expectToRejectCode(
      fixture.runtime.close(),
      'JG_AGENT_HQ_TRANSPORT_FAILED',
      'The HQ store failed',
    );
    expect(await readFile(join(fixture.stateRoot, 'hq-owner.json'), 'utf8')).toContain('serve');
  } finally {
    await fixture.runtime.close().catch(() => undefined);
    try {
      const pids = z
        .object({ parent: z.number().int().positive(), child: z.number().int().positive() })
        .parse(JSON.parse(await readFile(join(fixture.root, 'pids.json'), 'utf8')));
      for (const pid of [pids.parent, pids.child]) {
        let stopped = false;
        try {
          process.kill(pid, 0);
        } catch (error) {
          stopped = hasErrorCode(error, 'ESRCH');
        }
        expect(stopped).toBe(true);
      }
      await rm(fixture.root, { recursive: true });
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

test('short names are suggested without reservation and resolved without replacing immutable IDs', async () => {
  const fixture = await setup();
  try {
    const first = await fixture.create('build-usage');
    expect(
      await fixture.request({ kind: 'suggest-thread-name', topic: 'Build usage!' }),
    ).toStrictEqual({ kind: 'suggest-thread-name', result: { name: 'build-usage-2' } });
    const created = await Promise.all([
      fixture.create('build-usage'),
      fixture.create('build-usage'),
    ]);
    expect(created.map(({ thread }) => thread.name).sort()).toStrictEqual([
      'build-usage-2',
      'build-usage-3',
    ]);
    expect(new Set([first.thread.id, ...created.map(({ thread }) => thread.id)]).size).toBe(3);
    expect(
      await fixture.request({ kind: 'managed-thread-name', name: 'BUILD-USAGE' }),
    ).toStrictEqual({ kind: 'managed-thread-name', result: await fixture.thread(first.thread.id) });
    expect(
      await fixture.request({ kind: 'managed-thread-name', name: 'missing-task' }),
    ).toStrictEqual({ kind: 'managed-thread-name', result: null });
    const long = await fixture.create('a'.repeat(32));
    const collision = await fixture.create('a'.repeat(32));
    expect(long.thread.name).toHaveLength(32);
    expect(collision.thread.name).toBe('a'.repeat(30) + '-2');
    const rename = await fixture.submit(
      fixture.envelope({ kind: 'thread-rename', threadId: first.thread.id, name: 'review-usage' }),
    );
    await fixture.until(
      () => fixture.receipt(rename.id),
      (receipt) => receipt.delivery === 'acknowledged',
    );
    expect(
      await fixture.request({ kind: 'managed-thread-name', name: 'build-usage' }),
    ).toMatchObject({ result: null });
    expect(
      await fixture.request({ kind: 'managed-thread-name', name: 'REVIEW-USAGE' }),
    ).toMatchObject({ result: { id: first.thread.id, nativeId: first.thread.nativeId } });
    const names = (await fixture.calls())
      .filter((call) => call.method === 'thread/name/set')
      .map((call) => call.params.name);
    expect(names).toContain('build-usage-2');
    expect(names).toContain('review-usage');
  } finally {
    await fixture.close();
  }
});

test('readable lookup still authorizes the registered workspace and never adopts a native session', async () => {
  const fixture = await setup();
  try {
    const created = await fixture.create('private-task');
    await fixture.runtime.close();
    const other = join(fixture.root, 'other-workspace');
    await mkdir(other);
    const runtime = await createAgentHq({ stateRoot: fixture.stateRoot, allowedRoots: [other] });
    try {
      await expectToRejectCode(
        runtime.request({ kind: 'managed-thread-name', name: created.thread.name }),
        'JG_AGENT_HQ_TARGET_FORBIDDEN',
        'The HQ target is outside the allowed workspaces',
      );
    } finally {
      await runtime.close();
    }
  } finally {
    await fixture.close();
  }
});

test.each([
  [' Build usage ', 'build-usage'],
  ['Review / API feedback!', 'review-api-feedback'],
  ['---', 'session'],
  ['a'.repeat(31) + ' topic', 'a'.repeat(31)],
  ['a'.repeat(64), 'a'.repeat(32)],
])('native-independent name suggestion(%s) -> %s', async (topic, name) => {
  const fixture = await setup();
  try {
    expect(await fixture.request({ kind: 'suggest-thread-name', topic })).toStrictEqual({
      kind: 'suggest-thread-name',
      result: { name },
    });
    expect((await fixture.calls()).some((call) => call.method === 'thread/start')).toBe(false);
  } finally {
    await fixture.close();
  }
});
