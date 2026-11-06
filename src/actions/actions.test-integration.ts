// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { inspectLock } from 'jg-locks';
import { createAgentHq, requestAgentHq, type IAgentHq } from 'jg-agent-hq';
import type {
  IHqRequestInput,
  IActionCommand,
  IActionEnvelope,
  IActionReceipt,
  IActionWait,
  IManagedThread,
} from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  countHeldDelays,
  installCodexFixture,
  releaseHeldDelays,
  startHoldingDelays,
  stateLocks,
  stopHoldingDelays,
  waitForWarmUp,
  writeFixtureControl,
  withClaudeRuntime,
} from '../../scripts/test-support/index.js';

test('64-character suggestions and concurrent admissions retain complete growing collision suffixes', async () => {
  await withClaudeRuntime(async ({ runtime, request, workspaceRoot }) => {
    await waitForWarmUp(runtime);
    const runtimeEpoch = (await request({ kind: 'status' })).result.runtimeEpoch;
    const name = 'build-agent-composer-with-inline-code-blocks-and-markdown-tables';
    expect(
      (
        await request({
          kind: 'suggest-thread-name',
          topic: name.toUpperCase() + '!!! extra words',
        })
      ).result.name,
    ).toBe(name);
    expect((await request({ kind: 'suggest-thread-name', topic: '!!!' })).result.name).toBe(
      'session',
    );
    const create = async () => {
      const admitted = await request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch,
          command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name },
        },
      });
      const settled = await request({
        kind: 'action-wait',
        actionId: admitted.result.id,
        until: 'settled',
        timeoutMs: 5000,
      });
      expect(settled.result).toMatchObject({
        isTimedOut: false,
        receipt: { delivery: 'acknowledged' },
      });
      return (await request({ kind: 'managed-thread', threadId: admitted.result.threadId! }))
        .result!;
    };
    const threads = await Promise.all([create(), create()]);
    for (let ordinal = 3; ordinal <= 10; ordinal++) threads.push(await create());
    expect(threads.map((thread) => thread.name).sort()).toStrictEqual(
      [
        'build-agent-composer-with-inline-code-blocks-and-markdown-tables',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-2',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-3',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-4',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-5',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-6',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-7',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-8',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tabl-9',
        'build-agent-composer-with-inline-code-blocks-and-markdown-tab-10',
      ].sort(),
    );
    expect(new Set(threads.map((thread) => thread.id)).size).toBe(10);
    expect(new Set(threads.map((thread) => thread.nativeId)).size).toBe(10);
    expect((await request({ kind: 'suggest-thread-name', topic: name })).result.name).toBe(
      'build-agent-composer-with-inline-code-blocks-and-markdown-tab-11',
    );
  });
});

test.each(['codex', 'claude'] as const)(
  '%s creates, adopts and renames long names without changing identities or dispatching invalid names',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const { runtime, request, workspaceRoot, root } = fixture;
      await waitForWarmUp(runtime);
      const runtimeEpoch = (await request({ kind: 'status' })).result.runtimeEpoch;
      const submit = async (command: IActionCommand) => {
        const admitted = await request({
          kind: 'action',
          action: { id: randomUUID(), runtimeEpoch, command },
        });
        const settled = await request({
          kind: 'action-wait',
          actionId: admitted.result.id,
          until: 'settled',
          timeoutMs: 5000,
        });
        expect(settled.result).toMatchObject({
          isTimedOut: false,
          receipt: { delivery: 'acknowledged' },
        });
        return (await request({ kind: 'managed-thread', threadId: admitted.result.threadId! }))
          .result!;
      };
      const created = await submit({
        kind: 'thread-create',
        provider,
        workspaceRoot,
        name: 'build-agent-composer-with-inline-code-blocks-and-markdown-tables',
      });
      const renamed = await submit({
        kind: 'thread-rename',
        threadId: created.id,
        name: 'draft-agent-composer-with-inline-code-blocks-and-markdown-tables',
      });
      expect(renamed).toMatchObject({
        id: created.id,
        nativeId: created.nativeId,
        name: 'draft-agent-composer-with-inline-code-blocks-and-markdown-tables',
      });
      const nativeId = provider === 'claude' ? randomUUID() : 'external-long-name';
      if (provider === 'claude')
        await writeFile(
          fixture.transcript(nativeId),
          JSON.stringify(claudeRecord(workspaceRoot, nativeId)) + '\n',
        );
      const adopted = await submit({
        kind: 'thread-adopt',
        provider,
        workspaceRoot,
        nativeId,
        name: renamed.name,
        operatorConfirmation: 'The native CLI controller is closed',
      });
      expect(adopted).toMatchObject({
        nativeId,
        name: 'draft-agent-composer-with-inline-code-blocks-and-markdown-tabl-2',
      });
      expect(adopted.id).not.toBe(created.id);
      expect(
        (await request({ kind: 'thread', provider, workspaceRoot, nativeId: created.nativeId! }))
          .result,
      ).toMatchObject({ managedId: created.id, name: renamed.name });
      const logPath = join(root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl');
      const before = await readFile(logPath, 'utf8');
      for (const name of ['a'.repeat(65), 'Invalid_name']) {
        for (const command of [
          { kind: 'thread-create', provider, workspaceRoot, name },
          {
            kind: 'thread-adopt',
            provider,
            workspaceRoot,
            nativeId,
            name,
            operatorConfirmation: 'The native CLI controller is closed',
          },
          { kind: 'thread-rename', threadId: created.id, name },
        ] satisfies IActionCommand[]) {
          const id = randomUUID();
          await expectToRejectCode(
            runtime.request({ kind: 'action', action: { id, runtimeEpoch, command } }),
            'JG_AGENT_HQ_REQUEST_INVALID',
            'The HQ request is invalid',
          );
          expect((await request({ kind: 'receipt', actionId: id })).result).toBeNull();
        }
      }
      expect(await readFile(logPath, 'utf8')).toBe(before);
      expect(
        (await request({ kind: 'managed-thread', threadId: created.id })).result,
      ).toStrictEqual(renamed);
    });
  },
);

// a re-check's 2-second re-read is released by the tests that hold it instead of waited out
vi.mock('jg-utilities', async (original) => {
  const actual = await original<typeof import('jg-utilities')>();
  const { holdDelays } = await import('../../scripts/test-support/delays.js');
  return { ...actual, delay: holdDelays(actual.delay) };
});

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
    const request = <TCommand extends IHqRequestInput>(command: TCommand) =>
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
    const actionWait = async (
      actionId: string,
      until: 'native' | 'settled',
      timeoutMs = 5000,
    ): Promise<IActionWait> => {
      const response = await request({ kind: 'action-wait', actionId, until, timeoutMs });
      if (response.kind !== 'action-wait') throw new Error('wrong response');
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
      actionWait,
      until,
      create,
      control: (settings: Record<string, unknown>) =>
        writeFixtureControl(root, 'control.json', settings),
      calls: async () =>
        (await readFile(join(root, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
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

test.each(['codex', 'claude'] as const)(
  'native lineage for %s survives runtime restart from the HQ record, not the native session',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot, root }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime');
      const id = randomUUID();
      const created = await runtime.request({
        kind: 'action',
        action: {
          id,
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'thread-create', provider, workspaceRoot, name: 'lineage-durability' },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      const thread = await runtime.request({
        kind: 'managed-thread',
        threadId: created.result.threadId!,
      });
      if (thread.kind !== 'managed-thread' || !thread.result) throw new Error('Missing thread');
      expect(thread.result.nativeLineage).toStrictEqual({
        sessionId: provider === 'codex' ? 'session-for-native-1' : thread.result.nativeId,
        parentThreadId: null,
        forkedFromId: null,
      });
      await runtime.close();
      // the Codex session HQ created has no turns in the daemon that keeps it
      await writeFixtureControl(root, 'control.json', {
        threadTurns: { [thread.result.nativeId!]: [] },
      });
      const callsBefore = await readFile(join(root, 'calls.jsonl'), 'utf8');
      const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
      try {
        const reopenedStatus = await reopened.request({ kind: 'status' });
        if (reopenedStatus.kind !== 'status') throw new Error('Missing runtime');
        const saved = thread.result;
        // a Codex session outlives the runtime, which rejoins it; a Claude session stays closed
        await expect
          .poll(() => reopened.request({ kind: 'managed-thread', threadId: saved.id }))
          .toMatchObject({
            kind: 'managed-thread',
            result: {
              id: saved.id,
              nativeId: saved.nativeId,
              nativeLineage: saved.nativeLineage,
              ...(provider === 'codex'
                ? { runtimeEpoch: reopenedStatus.result.runtimeEpoch, state: 'idle' }
                : { runtimeEpoch: null, state: 'inactive' }),
            },
          });
        const calls = () => readFile(join(root, 'calls.jsonl'), 'utf8');
        if (provider === 'claude') expect(await calls()).toBe(callsBefore);
        else
          // the record is bound before the join runs, so the join's calls are awaited, not read once
          await expect
            .poll(async () =>
              (await calls())
                .slice(callsBefore.length)
                .trim()
                .split('\n')
                .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)).method)
                // every connection also lists the sessions the daemon has loaded, for any client
                .filter(
                  (method) =>
                    method !== 'thread/loaded/list' &&
                    (method.startsWith('thread/') || method.startsWith('turn/')),
                ),
            )
            .toStrictEqual([
              'thread/read',
              'thread/turns/list',
              'thread/resume',
              'thread/turns/list',
            ]);
      } finally {
        await reopened.close();
      }
    });
  },
);

test(
  'live Codex items take their running turn start as their time',
  { tags: ['full'] },
  async () => {
    const fixture = await setup();
    try {
      const { thread } = await fixture.create('times');
      const message = fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Time it' },
      });
      await fixture.submit(message);
      await expect
        .poll(() => fixture.receipt(message.id))
        .toMatchObject({ completion: 'completed' });
      // the fake starts turn N at 1,800,000,000 + N seconds
      const turnNumber = Number(
        /^native-turn-(\d+)$/.exec((await fixture.receipt(message.id)).nativeTurnId!)![1],
      );
      const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
      if (live.kind !== 'live-items') throw new Error('wrong response');
      expect(live.result.data.map((item) => [item.text, item.createdAt])).toStrictEqual([
        ['Live response', (1_800_000_000 + turnNumber) * 1000],
      ]);
    } finally {
      await fixture.close();
    }
  },
);

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
    // a Codex session starts with its workspace alone, never with tools HQ serves
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

test('approval state survives answer resolution and runtime restart without retaining prompt bodies', async () => {
  const fixture = await setup();
  let restarted: IAgentHq | undefined;
  try {
    const { thread } = await fixture.create('durable-approval');
    await fixture.control({
      prompt: {
        method: 'item/commandExecution/requestApproval',
        params: {
          startedAtMs: Date.now(),
          command: 'echo private-prompt-marker',
          cwd: fixture.workspaceRoot,
        },
      },
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Check native permission' },
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'waiting-approval',
    );
    const pending = await fixture.request({ kind: 'approvals', threadId: thread.id });
    if (pending.kind !== 'approvals') throw new Error('Wrong response');
    expect(pending.result).toMatchObject({ data: [{ state: 'pending' }], nextCursor: null });
    const approval = pending.result.data[0]!;
    expect(approval.presentation?.detail).toContain('private-prompt-marker');
    const reply = await fixture.submit(
      fixture.envelope({
        kind: 'native-reply',
        threadId: thread.id,
        expectedTurnId: approval.nativeTurnId,
        approvalId: approval.id,
        response: { kind: 'decision', decision: 'decline' },
      }),
    );
    await fixture.until(
      () => fixture.receipt(reply.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const answered = await fixture.request({ kind: 'approvals', threadId: thread.id });
    expect(answered).toMatchObject({
      result: {
        data: [{ id: approval.id, state: 'answered', replyActionId: reply.id, presentation: null }],
      },
    });
    await fixture.runtime.close();
    restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    expect(await restarted.request({ kind: 'approvals', threadId: thread.id })).toStrictEqual(
      answered,
    );
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      expect(
        JSON.stringify(database.prepare('SELECT * FROM agent_hq_native_approval').all()),
      ).not.toContain('private-prompt-marker');
    } finally {
      database.close();
    }
  } finally {
    await restarted?.close();
    await fixture.close();
  }
});

test('approval history uses indexed, query-bound seek pages and expires requests from another runtime', async () => {
  const fixture = await setup();
  let restarted: IAgentHq | undefined;
  try {
    const { thread } = await fixture.create('approval-pages');
    await fixture.runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    const ids = Array.from(
      { length: 4 },
      (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`,
    );
    try {
      const insert = database.prepare(
        "INSERT INTO agent_hq_native_approval (id, thread_id, native_turn_id, runtime_epoch, native_request_id, digest, kind, is_blocking, state, created_at, updated_at) VALUES (?, ?, 'fixture-turn', ?, ?, ?, 'question', 1, ?, 100, 100)",
      );
      for (const [index, id] of ids.entries())
        insert.run(
          id,
          thread.id,
          thread.runtimeEpoch!,
          id,
          '0'.repeat(64),
          index === 0 ? 'pending' : index === 1 ? 'expired' : 'answered',
        );
      for (const state of [false, true]) {
        const plan = database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT id FROM agent_hq_native_approval WHERE thread_id = ? ${state ? "AND state = 'answered'" : ''} AND (created_at, id) < (100, ?) ORDER BY created_at DESC, id DESC LIMIT 3`,
          )
          .all(thread.id, ids[3]!);
        expect(JSON.stringify(plan)).toContain(
          state
            ? 'agent_hq_idx_na__thread_id_state_created_at_id_desc'
            : 'agent_hq_idx_na__thread_id_created_at_id_desc',
        );
        expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
      }
    } finally {
      database.close();
    }
    restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    const read = async (cursor?: string, state?: 'answered' | 'expired') => {
      const response = await restarted!.request({
        kind: 'approvals',
        threadId: thread.id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
        ...(state ? { state } : {}),
      });
      if (response.kind !== 'approvals') throw new Error('Wrong response');
      return response.result;
    };
    const first = await read();
    expect(first.data.map((row) => row.id)).toStrictEqual([ids[3], ids[2]]);
    expect(first.nextCursor).toBeTypeOf('string');
    const final = await read(first.nextCursor!);
    expect(final.data.map((row) => [row.id, row.state, row.presentation])).toStrictEqual([
      [ids[1], 'expired', null],
      [ids[0], 'expired', null],
    ]);
    expect(final.nextCursor).toBeNull();
    expect((await read(undefined, 'answered')).data.map((row) => row.id)).toStrictEqual([
      ids[3],
      ids[2],
    ]);
    expect((await read(undefined, 'expired')).data).toHaveLength(2);
    await expectToRejectCode(read(first.nextCursor!, 'answered'), 'JG_AGENT_HQ_CURSOR_INVALID');
    await expectToRejectCode(read('invalid-cursor'), 'JG_AGENT_HQ_CURSOR_INVALID');
    const cursor = first.nextCursor!;
    await expectToRejectCode(
      read(`${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`),
      'JG_AGENT_HQ_CURSOR_INVALID',
    );
    const status = await restarted.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Wrong response');
    await expectToRejectCode(
      restarted.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'native-reply',
            threadId: thread.id,
            expectedTurnId: 'fixture-turn',
            approvalId: ids[0]!,
            response: { kind: 'answers', answers: { choice: ['blue'] } },
          },
        },
      }),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
  } finally {
    await restarted?.close();
    await fixture.close();
  }
});

test.each(['form', 'url'] as const)(
  'Codex %s elicitation validates the exact request and stores only resolution metadata',
  async (mode) => {
    const fixture = await setup();
    try {
      const { thread } = await fixture.create('elicit-' + mode);
      await fixture.control({
        prompt: {
          method: 'mcpServer/elicitation/request',
          params: {
            mode,
            serverName: 'fixture',
            message: 'Provide a bounded example',
            _meta: null,
            ...(mode === 'form'
              ? {
                  requestedSchema: {
                    type: 'object',
                    properties: { color: { type: 'string', enum: ['blue'] } },
                    required: ['color'],
                    additionalProperties: false,
                  },
                }
              : { url: 'https://example.com/authorize', elicitationId: 'native-elicit' }),
          },
        },
      });
      await fixture.submit(
        fixture.envelope({
          kind: 'message',
          threadId: thread.id,
          input: { kind: 'text', text: 'Check elicitation' },
        }),
      );
      await fixture.until(
        () => fixture.thread(thread.id),
        (entry) => entry.state === 'waiting-approval',
      );
      const response = await fixture.request({ kind: 'approvals', threadId: thread.id });
      if (response.kind !== 'approvals') throw new Error('Wrong response');
      const approval = response.result.data[0]!;
      expect(approval.presentation?.elicitation).toMatchObject({ mode, serverName: 'fixture' });
      const invalidContents: Record<string, string | boolean>[] = [
        { color: 'red' },
        { color: 'blue', unexpected: true },
      ];
      for (const content of invalidContents) {
        await expectToRejectCode(
          fixture.submit(
            fixture.envelope({
              kind: 'native-reply',
              threadId: thread.id,
              expectedTurnId: approval.nativeTurnId,
              approvalId: approval.id,
              response: { kind: 'elicitation', action: 'accept', content },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
        );
      }
      const content = mode === 'form' ? { color: 'blue' } : null;
      const reply = await fixture.submit(
        fixture.envelope({
          kind: 'native-reply',
          threadId: thread.id,
          expectedTurnId: approval.nativeTurnId,
          approvalId: approval.id,
          response: { kind: 'elicitation', action: 'accept', content },
        }),
      );
      await fixture.until(
        () => fixture.receipt(reply.id),
        (entry) => entry.delivery === 'acknowledged',
      );
      expect(
        JSON.parse((await readFile(join(fixture.root, 'replies.jsonl'), 'utf8')).trim()),
      ).toStrictEqual({
        id: 'native-approval-1',
        result: { action: 'accept', content, _meta: null },
      });
      expect(await fixture.request({ kind: 'approvals', threadId: thread.id })).toMatchObject({
        result: { data: [{ state: 'answered', replyActionId: reply.id, presentation: null }] },
      });
    } finally {
      await fixture.close();
    }
  },
);

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
    expect(prompts.result.data).toHaveLength(1);
    const answer = fixture.envelope({
      kind: 'native-reply',
      threadId: thread.id,
      expectedTurnId: active.activeTurnId!,
      approvalId: prompts.result.data[0]!.id,
      response: { kind: 'answers', answers: { choice: ['fictional-answer-for-the-test'] } },
    });
    await fixture.control({ replyResolutionDelay: 500 });
    const reply = await fixture.submit(answer);
    expect(await fixture.request({ kind: 'approvals', threadId: thread.id })).toMatchObject({
      result: { data: [{ replyActionId: reply.id, state: 'pending' }] },
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
        database.prepare('SELECT id, digest, queued_input FROM agent_hq_action').all(),
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
      const approval = response.result.data[0]!;
      expect(approval.kind).toBe(kind);
      expect(approval.presentation!.decisions).toStrictEqual(
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

test('Codex live items present what history will, leaving reasoning out', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('live-presentation');
    await fixture.control({
      turnItems: [
        { id: 'live-reasoning', type: 'reasoning', summary: [], content: ['private'] },
        {
          id: 'live-change',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/workspace/a.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' }],
        },
      ],
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Add a file' },
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'completed',
    );
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (live.kind !== 'live-items') throw new Error('Missing live items');
    expect(
      live.result.data.map(({ nativeId, kind, outcome, files }) => ({
        nativeId,
        kind,
        outcome,
        files,
      })),
    ).toStrictEqual([
      { nativeId: 'live-1', kind: 'agent-message', outcome: null, files: [] },
      {
        nativeId: 'live-change',
        kind: 'file-change',
        outcome: 'succeeded',
        files: [{ path: '/workspace/a.ts', added: 2, removed: 0 }],
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test('live items remain available through native flush', async () => {
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
    expect((await fixture.receipt(action.id)).completion).toBe('completed');
  } finally {
    await fixture.close();
  }
});

test("a finished turn's saved items leave the live window once its history holds them, though no client reads it", async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('turn-flush');
    const image = { id: 'live-image', type: 'imageView', path: '/workspace/shot.png' };
    await fixture.control({
      turnItems: [image],
      items: [
        { turnId: 'native-turn-1', item: image },
        {
          turnId: 'native-turn-1',
          item: { id: 'live-1', type: 'agentMessage', text: 'Live response' },
        },
      ],
    });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Show the screenshot' },
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'completed',
    );
    const live = await fixture.until(
      () => fixture.request({ kind: 'live-items', threadId: thread.id }),
      (response) => response.kind === 'live-items' && response.result.data.length === 0,
    );
    expect(live).toMatchObject({ kind: 'live-items', result: { data: [], hasGap: false } });
  } finally {
    await fixture.close();
  }
});

test('a finished turn whose history trails its end is read once more, and then leaves the live window', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('turn-flush-late');
    await fixture.control({ awaitingFlush: true });
    await fixture.submit(
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
    const turnReads = async () =>
      (await fixture.calls()).filter(
        ({ method, params }) =>
          method === 'thread/items/list' && params['turnId'] === 'native-turn-1',
      );
    // the read as the turn ends finds nothing saved yet, so the item stays
    await fixture.until(turnReads, (reads) => reads.length === 1);
    expect(await fixture.request({ kind: 'live-items', threadId: thread.id })).toMatchObject({
      result: { data: [{ nativeId: 'live-1', state: 'awaiting-flush' }] },
    });
    await fixture.control({
      items: [
        {
          turnId: 'native-turn-1',
          item: { id: 'live-1', type: 'agentMessage', text: 'Live response' },
        },
      ],
    });
    await fixture.until(
      () => fixture.request({ kind: 'live-items', threadId: thread.id }),
      (response) => response.kind === 'live-items' && response.result.data.length === 0,
      5000,
    );
    expect(await turnReads()).toHaveLength(2);
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

test('a message Codex cut and never saved leaves the live window once history holds its turn', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('cut-message');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Explain worktrees' },
      }),
    );
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const steer = await fixture.submit(
      fixture.envelope({
        kind: 'steer',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        text: 'End with: Steering received.',
      }),
    );
    await fixture.until(
      () => fixture.receipt(steer.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    // the turn ends with its first message started and never finished
    await fixture.submit(
      fixture.envelope({
        kind: 'interrupt',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'interrupted',
    );
    const cut = await fixture.request({ kind: 'live-items', threadId: thread.id });
    expect(
      cut.kind === 'live-items' &&
        cut.result.data.map(({ nativeId, text, state }) => [nativeId, text, state]),
    ).toStrictEqual([['live-1', 'Live response', 'awaiting-flush']]);
    // a page of another turn leaves it waiting
    await fixture.control({
      items: [
        {
          turnId: 'earlier-turn',
          item: { id: 'earlier', type: 'agentMessage', text: 'Earlier answer' },
        },
      ],
    });
    await fixture.request({
      kind: 'items',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: thread.nativeId!,
    });
    expect(await fixture.request({ kind: 'live-items', threadId: thread.id })).toStrictEqual(cut);
    await fixture.control({
      items: [
        {
          turnId: active.activeTurnId!,
          item: { id: 'answer', type: 'agentMessage', text: 'Steering received.' },
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
      result: { data: [], nextCursor: null },
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
    const approval = result.result.data[0]!;
    expect(JSON.parse(approval.presentation!.detail).permissions).toStrictEqual(permissions);
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

test('control seek pages preserve tied ordering, reject changed filters and carry queued text cut to their limit', async () => {
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
    // a page carries each queued input's text, cut to its limit, but never the input itself
    const cut = await fixture.request({
      kind: 'actions',
      threadId: first.id,
      limit: 1,
      textLimit: 10,
    });
    expect(cut.result.data).toStrictEqual([
      expect.objectContaining({
        id: queued.id,
        queuedText: { text: 'A selected', isTruncated: true },
      }),
    ]);
    expect(cut.result.data[0]).not.toHaveProperty('queuedInput');
    // the text limit cuts a page's text only, so its continuation may change it
    const rest = await fixture.request({
      kind: 'actions',
      threadId: first.id,
      limit: 1,
      cursor: cut.result.nextCursor!,
    });
    expect(rest.result.data.map((action) => [action.kind, action.queuedText])).toStrictEqual([
      ['message', null],
    ]);
    const whole = await fixture.request({ kind: 'actions', threadId: first.id, limit: 1 });
    expect(whole.result.data[0]!.queuedText).toStrictEqual({
      text: 'A selected queue body',
      isTruncated: false,
    });
    expect((await fixture.receipt(queued.id)).queuedInput?.text).toBe('A selected queue body');
    const cancel = await fixture.submit(
      fixture.envelope({ kind: 'queue-cancel', queuedActionId: queued.id }),
    );
    expect(cancel.delivery).toBe('acknowledged');
    expect(await fixture.receipt(queued.id)).toMatchObject({
      delivery: 'canceled',
      queuedInput: null,
    });
    const canceled = await fixture.request({ kind: 'actions', threadId: first.id, limit: 128 });
    expect(canceled.result.data.every((action) => action.queuedText === null)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('action-wait returns a created session native thread ID once HQ records it, and an unknown action at once', async () => {
  const fixture = await setup();
  try {
    const create = fixture.envelope({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name: 'wait-native',
    });
    const admitted = await fixture.submit(create);
    expect(admitted.nativeThreadId).toBeNull();
    const native = await fixture.actionWait(create.id, 'native');
    expect(native.isTimedOut).toBe(false);
    const thread = await fixture.thread(admitted.threadId!);
    expect(thread.nativeId).not.toBeNull();
    expect(native.receipt).toMatchObject({ id: create.id, nativeThreadId: thread.nativeId });
    expect(await fixture.actionWait(create.id, 'settled')).toMatchObject({
      isTimedOut: false,
      receipt: { delivery: 'acknowledged', nativeThreadId: thread.nativeId },
    });
    expect((await fixture.receipt(create.id)).nativeThreadId).toBe(thread.nativeId);
    // action collections leave the native thread to their selected receipts
    const actions = await fixture.request({ kind: 'actions', threadId: thread.id });
    if (actions.kind !== 'actions') throw new Error('wrong response');
    expect(actions.result.data[0]).not.toHaveProperty('nativeThreadId');
    expect(await fixture.actionWait(randomUUID(), 'settled')).toStrictEqual({
      receipt: null,
      isTimedOut: false,
    });
  } finally {
    await fixture.close();
  }
});

test('action-wait returns a settled delivery once HQ records it, or the receipt with isTimedOut when its time runs out', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('wait-settled');
    await fixture.control({ holdTurn: true });
    const message = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Keep this turn active' },
    });
    await fixture.submit(message);
    expect(await fixture.actionWait(message.id, 'settled')).toMatchObject({
      isTimedOut: false,
      receipt: { delivery: 'acknowledged', nativeThreadId: thread.nativeId },
    });
    const active = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const queued = await fixture.submit(
      fixture.envelope({
        kind: 'queue',
        threadId: thread.id,
        expectedTurnId: active.activeTurnId!,
        input: { kind: 'text', text: 'The next task' },
      }),
    );
    // a queued entry already has its thread's native session, but stays unsettled while it waits
    expect(await fixture.actionWait(queued.id, 'native')).toMatchObject({
      isTimedOut: false,
      receipt: { delivery: 'queued', nativeThreadId: thread.nativeId },
    });
    expect(await fixture.actionWait(queued.id, 'settled', 50)).toMatchObject({
      isTimedOut: true,
      receipt: { id: queued.id, delivery: 'queued' },
    });
    const settling = fixture.actionWait(queued.id, 'settled');
    await fixture.submit(fixture.envelope({ kind: 'queue-cancel', queuedActionId: queued.id }));
    expect(await settling).toMatchObject({
      isTimedOut: false,
      receipt: { id: queued.id, delivery: 'canceled' },
    });
  } finally {
    await fixture.close();
  }
});

test('action-wait ends early when the runtime closes while it waits', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('wait-close');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Keep this turn active' },
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
        input: { kind: 'text', text: 'The next task' },
      }),
    );
    // the wait's 30 seconds exceed this test's own timeout, so only closing can end it in time
    const ended = expectToRejectCode(
      fixture.runtime.request({
        kind: 'action-wait',
        actionId: queued.id,
        until: 'settled',
        timeoutMs: 30_000,
      }),
      'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
      'The HQ runtime is not running',
    );
    await fixture.runtime.close();
    await ended;
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
    /*
     * The daemon sends the notifications before its answer to the request, and live items never
     * wait in the event lane, so the window holds them once the request returns.
     */
    const send = (events: { method: string; params: object }[]) =>
      emit(fixture, { holdTurn: true }, events);
    await send(
      Array.from({ length: 130 }, (_, index) => ({
        method: 'item/completed',
        params: {
          threadId: thread.nativeId,
          turnId: active.activeTurnId,
          item: { id: `bounded-${index}`, type: 'agentMessage', text: 'Small item' },
        },
      })),
    );
    const bounded = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (bounded.kind !== 'live-items') throw new Error('wrong response');
    expect(bounded.result.data).toHaveLength(128);
    expect(bounded.result.hasGap).toBe(true);
    await send(
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
    await send([
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

test('shutdown waits for admission and leaves a Codex session bound, unless its message failed', async () => {
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
    expect(calls).not.toContain('turn/interrupt');
    expect(calls).not.toContain('thread/backgroundTerminals/clean');
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      const saved = database
        .prepare('SELECT state, runtime_epoch, pending_action_id FROM agent_hq_thread WHERE id = ?')
        .get(thread.id);
      const message = database
        .prepare('SELECT delivery FROM agent_hq_action WHERE id = ?')
        .get(action.id);
      // a message shutdown refused to send leaves its action pending, which releases the session
      if (message?.delivery === 'failed')
        expect(saved).toMatchObject({ state: 'inactive', runtime_epoch: null });
      else
        expect(saved).toMatchObject({
          runtime_epoch: action.runtimeEpoch,
          pending_action_id: null,
        });
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test('shutdown interrupts every active Claude session at once and leaves Codex turns running', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot, workspaceRoot, request, control }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime');
    const runtimeEpoch = status.result.runtimeEpoch;
    const settle = async (command: IActionCommand): Promise<IActionReceipt> => {
      const id = randomUUID();
      await request({ kind: 'action', action: { id, runtimeEpoch, command } });
      return expect
        .poll(async () => {
          const response = await request({ kind: 'receipt', actionId: id });
          return response.kind === 'receipt' ? response.result : null;
        })
        .toMatchObject({ delivery: 'acknowledged' })
        .then(async () => {
          const response = await request({ kind: 'receipt', actionId: id });
          if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
          return response.result;
        });
    };
    await control({ holdTurn: true });
    await writeFixtureControl(root, 'control.json', { holdTurn: true });
    const threadIds: Record<string, string> = {};
    for (const [name, provider] of [
      ['stop-one', 'claude'],
      ['stop-two', 'claude'],
      ['stop-three', 'claude'],
      ['stop-four', 'claude'],
      ['keep-codex', 'codex'],
    ] as const) {
      const created = await settle({ kind: 'thread-create', provider, workspaceRoot, name });
      threadIds[name] = created.threadId!;
      await settle({
        kind: 'message',
        threadId: created.threadId!,
        input: { kind: 'text', text: 'Keep this turn active' },
      });
      await expect
        .poll(() => request({ kind: 'managed-thread', threadId: created.threadId! }))
        .toMatchObject({ result: { state: 'running' } });
    }
    // The Claude fixture withholds each acknowledgement until all four sessions receive interruption.
    await control({ holdTurn: true, interruptBarrier: 4 });
    await runtime.close();
    const claudeCalls = (await readFile(join(root, 'claude-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) =>
        z.object({ request: z.object({ subtype: z.string() }).optional() }).parse(JSON.parse(line)),
      );
    expect(claudeCalls.filter((call) => call.request?.subtype === 'interrupt')).toHaveLength(4);
    const codexCalls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)).method);
    expect(codexCalls).not.toContain('turn/interrupt');
    expect(codexCalls).not.toContain('thread/backgroundTerminals/clean');
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      const saved = (name: string) =>
        database
          .prepare(
            'SELECT ownership, state, runtime_epoch, active_turn_id FROM agent_hq_thread WHERE id = ?',
          )
          .get(threadIds[name]!);
      for (const name of ['stop-one', 'stop-two', 'stop-three', 'stop-four'])
        expect(saved(name)).toMatchObject({ state: 'inactive', runtime_epoch: null });
      expect(saved('keep-codex')).toMatchObject({
        ownership: 'managed',
        state: 'running',
        runtime_epoch: runtimeEpoch,
        active_turn_id: expect.any(String),
      });
    } finally {
      database.close();
    }
  });
});

test('the next runtime rejoins the Codex sessions a shutdown left running and catches up on finished turns', async () => {
  const fixture = await setup();
  let reopened: IAgentHq | undefined;
  try {
    await fixture.control({ holdTurn: true });
    const running = (await fixture.create('keep-running')).thread;
    const finishing = (await fixture.create('keep-finishing')).thread;
    const idle = (await fixture.create('keep-idle')).thread;
    const messages = new Map<string, string>();
    for (const thread of [running, finishing]) {
      const action = fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Keep working' },
      });
      await fixture.submit(action);
      messages.set(thread.id, action.id);
      await fixture.until(
        () => fixture.thread(thread.id),
        (entry) => entry.state === 'running',
      );
    }
    const runningTurn = (await fixture.thread(running.id)).activeTurnId!;
    const finishingTurn = (await fixture.thread(finishing.id)).activeTurnId!;
    await fixture.runtime.close();
    // while HQ was stopped, the daemon kept one turn running and finished the other
    const daemon = {
      threadStatuses: {
        [running.nativeId!]: { type: 'active', activeFlags: [] },
        [finishing.nativeId!]: { type: 'idle' },
        [idle.nativeId!]: { type: 'idle' },
      },
      threadTurns: {
        [running.nativeId!]: [{ id: runningTurn, status: 'inProgress' }],
        [finishing.nativeId!]: [{ id: finishingTurn, status: 'completed' }],
        [idle.nativeId!]: [],
      },
    };
    await fixture.control(daemon);
    const callCount = (await fixture.calls()).length;
    reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    const status = await reopened.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime');
    const runtimeEpoch = status.result.runtimeEpoch;
    await fixture.until(
      () => fixture.thread(running.id),
      (entry) =>
        entry.runtimeEpoch === runtimeEpoch &&
        entry.ownership === 'managed' &&
        entry.state === 'running' &&
        entry.activeTurnId === runningTurn,
    );
    await fixture.until(
      () => fixture.thread(finishing.id),
      (entry) =>
        entry.runtimeEpoch === runtimeEpoch &&
        entry.state === 'completed' &&
        entry.activeTurnId === null,
    );
    await fixture.until(
      () => fixture.thread(idle.id),
      (entry) => entry.runtimeEpoch === runtimeEpoch && entry.state === 'idle',
    );
    expect(await fixture.receipt(messages.get(finishing.id)!)).toMatchObject({
      completion: 'completed',
    });
    expect(await fixture.receipt(messages.get(running.id)!)).toMatchObject({ completion: null });
    // rejoining changes no session's settings; a record is bound before its join, so joins are awaited
    const byThread = (left: Record<string, unknown>, right: Record<string, unknown>) =>
      String(left.threadId).localeCompare(String(right.threadId));
    await expect
      .poll(async () =>
        (await fixture.calls())
          .slice(callCount)
          .filter((call) => call.method === 'thread/resume')
          .map((call) => call.params)
          .sort(byThread),
      )
      .toStrictEqual(
        [running, finishing, idle]
          .map((thread) => ({ threadId: thread.nativeId!, excludeTurns: true }))
          .sort(byThread),
      );
    // the turn still running completes through the rejoined session
    await fixture.control({
      ...daemon,
      emitOnce: true,
      emit: [
        {
          method: 'turn/completed',
          params: { threadId: running.nativeId, turn: { id: runningTurn, status: 'completed' } },
        },
      ],
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await fixture.until(
      () => fixture.receipt(messages.get(running.id)!),
      (entry) => entry.completion === 'completed',
    );
    expect(await fixture.thread(running.id)).toMatchObject({
      state: 'completed',
      activeTurnId: null,
    });
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test('the next runtime answers the request a kept Codex turn still waits on', async () => {
  const fixture = await setup();
  let reopened: IAgentHq | undefined;
  try {
    const { thread } = await fixture.create('kept-approval');
    const prompt = {
      method: 'item/commandExecution/requestApproval',
      params: { startedAtMs: Date.now(), command: 'echo kept-request', cwd: fixture.workspaceRoot },
    };
    await fixture.control({ prompt });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Check native permission' },
      }),
    );
    const waiting = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'waiting-approval',
    );
    const turnId = waiting.activeTurnId!;
    await fixture.runtime.close();
    // shutdown neither declines the request nor stops its turn
    await expect(readFile(join(fixture.root, 'replies.jsonl'), 'utf8')).rejects.toThrow('ENOENT');
    expect((await fixture.calls()).map((call) => call.method)).not.toContain('turn/interrupt');
    await fixture.control({
      threadStatuses: {
        [thread.nativeId!]: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
      threadTurns: { [thread.nativeId!]: [{ id: turnId, status: 'inProgress' }] },
      resumePrompt: prompt,
      completeOnReply: true,
    });
    reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    const status = await reopened.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime');
    const runtimeEpoch = status.result.runtimeEpoch;
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.runtimeEpoch === runtimeEpoch && entry.state === 'waiting-approval',
    );
    const pending = await fixture.request({
      kind: 'approvals',
      threadId: thread.id,
      state: 'pending',
    });
    if (pending.kind !== 'approvals') throw new Error('Wrong response');
    const approval = pending.result.data.find((entry) => entry.runtimeEpoch === runtimeEpoch)!;
    expect(approval).toMatchObject({ nativeTurnId: turnId, state: 'pending' });
    expect(approval.presentation?.detail).toContain('kept-request');
    const reply: IActionEnvelope = {
      id: randomUUID(),
      runtimeEpoch,
      command: {
        kind: 'native-reply',
        threadId: thread.id,
        expectedTurnId: turnId,
        approvalId: approval.id,
        response: { kind: 'decision', decision: 'decline' },
      },
    };
    await fixture.request({ kind: 'action', action: reply });
    await fixture.until(
      () => fixture.receipt(reply.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'completed' && entry.activeTurnId === null,
    );
    expect(await readFile(join(fixture.root, 'replies.jsonl'), 'utf8')).toContain(
      'native-approval-resumed',
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test('a kept Codex session another client moved past its recorded turn is marked uncertain', async () => {
  const fixture = await setup();
  let reopened: IAgentHq | undefined;
  try {
    const { thread } = await fixture.create('moved-on');
    const message = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Finish one turn' },
    });
    await fixture.submit(message);
    const finished = await fixture.until(
      () => fixture.receipt(message.id),
      (entry) => entry.completion === 'completed',
    );
    await fixture.runtime.close();
    // a terminal ran another turn on the session while HQ was stopped
    await fixture.control({
      threadStatuses: { [thread.nativeId!]: { type: 'idle' } },
      threadTurns: {
        [thread.nativeId!]: [
          { id: finished.nativeTurnId, status: 'completed' },
          { id: 'terminal-turn', status: 'completed' },
        ],
      },
    });
    const callCount = (await fixture.calls()).length;
    reopened = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.ownership === 'uncertain' && entry.state === 'unknown',
    );
    expect((await fixture.calls()).slice(callCount).map((call) => call.method)).not.toContain(
      'thread/resume',
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test('overflowing native events stop control and preserve explicit uncertain ownership', async () => {
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
    // request resolutions are lifecycle evidence, which the provider's lane of 128 persists in order
    await fixture.control({
      holdTurn: true,
      emit: Array.from({ length: 2048 }, (_, index) => ({
        method: 'serverRequest/resolved',
        params: { threadId: thread.nativeId, requestId: `overflow-${index}` },
      })),
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
    await fixture.runtime.close();
    expect((await inspectLock('runtime', stateLocks(fixture.stateRoot))).state).toBe('free');
  } finally {
    // remove only the disposable fixture after proving native exit, including after a failed assertion
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

test('admission records a coded failure as a failed action, and rethrows a defect without recording it', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('admission-failures');
    // a coded failure of a known kind: the interrupt names a turn the idle session isn't running
    const interrupt = fixture.envelope({
      kind: 'interrupt',
      threadId: thread.id,
      expectedTurnId: 'turn-that-never-ran',
    });
    expect(await fixture.submit(interrupt)).toMatchObject({
      id: interrupt.id,
      delivery: 'failed',
      failure: 'state-conflict',
    });
    // a defect: SQLite itself refuses the rename's write, which no HQ error describes
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database.exec(
        "CREATE TRIGGER app_injected_defect BEFORE UPDATE OF pending_action_id ON agent_hq_thread BEGIN SELECT RAISE(ABORT, 'injected admission defect'); END",
      );
    } finally {
      database.close();
    }
    const rename = fixture.envelope({
      kind: 'thread-rename',
      threadId: thread.id,
      name: 'renamed-after-defect',
    });
    try {
      await expectToRejectCode(
        fixture.runtime.request({ kind: 'action', action: rename }),
        'JG_AGENT_HQ_STORE_FAILED',
        'The HQ store failed: injected admission defect',
      );
    } finally {
      const cleanup = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        cleanup.exec('DROP TRIGGER app_injected_defect');
      } finally {
        cleanup.close();
      }
    }
    expect(await fixture.request({ kind: 'receipt', actionId: rename.id })).toStrictEqual({
      kind: 'receipt',
      result: null,
    });
    // the rolled-back admission left the thread free for the next rename
    expect(await fixture.thread(thread.id)).toMatchObject({ name: 'admission-failures' });
    const retry = fixture.envelope({
      kind: 'thread-rename',
      threadId: thread.id,
      name: 'renamed-after-defect',
    });
    expect((await fixture.submit(retry)).delivery).not.toBe('failed');
    await fixture.until(
      () => fixture.thread(thread.id),
      (current) => current.name === 'renamed-after-defect',
    );
  } finally {
    await fixture.close();
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
      database.exec('DROP TABLE agent_hq_thread');
    } finally {
      database.close();
    }
    await expectToRejectCode(
      fixture.runtime.close(),
      'JG_AGENT_HQ_TRANSPORT_FAILED',
      'The HQ store failed',
    );
    expect(await inspectLock('runtime', stateLocks(fixture.stateRoot))).toMatchObject({
      state: 'held',
      owner: { pid: process.pid },
    });
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

test('short names are suggested without reservation and renamed without replacing immutable IDs', async () => {
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
    const long = await fixture.create('a'.repeat(32));
    const collision = await fixture.create('a'.repeat(32));
    expect(long.thread.name).toHaveLength(32);
    expect(collision.thread.name).toBe('a'.repeat(32) + '-2');
    const rename = await fixture.submit(
      fixture.envelope({ kind: 'thread-rename', threadId: first.thread.id, name: 'review-usage' }),
    );
    await fixture.until(
      () => fixture.receipt(rename.id),
      (receipt) => receipt.delivery === 'acknowledged',
    );
    expect(await fixture.thread(first.thread.id)).toMatchObject({
      name: 'review-usage',
      nativeId: first.thread.nativeId,
    });
    const names = (await fixture.calls())
      .filter((call) => call.method === 'thread/name/set')
      .map((call) => call.params.name);
    expect(names).toContain('build-usage-2');
    expect(names).toContain('review-usage');
  } finally {
    await fixture.close();
  }
});

test.each([
  [' Build usage ', 'build-usage'],
  ['Review / API feedback!', 'review-api-feedback'],
  ['---', 'session'],
  ['a'.repeat(31) + ' topic', 'a'.repeat(31) + '-topic'],
  ['a'.repeat(63) + ' topic', 'a'.repeat(63)],
  ['a'.repeat(64), 'a'.repeat(64)],
  ['a'.repeat(65), 'a'.repeat(64)],
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

test('HQ answers no request on a session another client drives, and still refuses one it cannot present on its own', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('own-session');
    const replies = async () => {
      try {
        return (await readFile(join(fixture.root, 'replies.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { id: string; error?: unknown });
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
      }
    };
    // a session another client drives, which HQ never controlled
    const other = 'thread-0003';
    await fixture.control({
      emitOnce: true,
      emitRequests: [
        {
          id: 'other-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: other,
            turnId: 'turn-other',
            itemId: 'item-other',
            startedAtMs: Date.now(),
            command: 'touch file',
            cwd: fixture.workspaceRoot,
            availableDecisions: ['accept', 'cancel'],
          },
        },
        { id: 'other-unknown', method: 'item/future/requestInput', params: { threadId: other } },
        {
          id: 'own-unknown',
          method: 'item/future/requestInput',
          params: { threadId: thread.nativeId },
        },
      ],
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    // only the request on HQ's own session is refused
    await expect.poll(replies).toMatchObject([{ id: 'own-unknown', error: expect.anything() }]);
    // the other client answers, and the daemon reports its requests resolved
    await fixture.control({
      emitOnce: true,
      emit: [
        {
          method: 'serverRequest/resolved',
          params: { threadId: other, requestId: 'other-approval' },
        },
        {
          method: 'serverRequest/resolved',
          params: { threadId: other, requestId: 'other-unknown' },
        },
      ],
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    const message = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Still here' },
    });
    await fixture.submit(message);
    await fixture.until(
      () => fixture.receipt(message.id),
      (entry) => entry.completion === 'completed',
    );
    expect((await replies()).map((reply) => reply.id)).toStrictEqual(['own-unknown']);
  } finally {
    await fixture.close();
  }
});

// starts one held Codex turn on a new session and returns the session with that turn's ID
const startHeldTurn = async (fixture: Awaited<ReturnType<typeof setup>>, name: string) => {
  const { thread } = await fixture.create(name);
  await fixture.control({ holdTurn: true });
  const message = fixture.envelope({
    kind: 'message',
    threadId: thread.id,
    input: { kind: 'text', text: `Work on ${name}` },
  });
  await fixture.submit(message);
  const running = await fixture.until(
    () => fixture.thread(thread.id),
    (entry) => entry.state === 'running' && entry.activeTurnId !== null,
  );
  return { thread, message, nativeId: thread.nativeId!, turnId: running.activeTurnId! };
};
// what Codex reports for one session: its status and its saved turns
const reads = (nativeId: string, status: object, turnId: string, turnStatus: string) => ({
  holdTurn: true,
  threadStatuses: { [nativeId]: status },
  threadTurns: {
    [nativeId]: [{ id: turnId, status: turnStatus, startedAt: 1_800_000_001, completedAt: null }],
  },
});
// the daemon sends notifications along with its answer to the next request
const emit = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  settings: object,
  notifications: object[],
) => {
  await fixture.control({ ...settings, emitOnce: true, emit: notifications });
  await fixture.request({ kind: 'usage', provider: 'codex' });
};
const lostCompletion = (nativeId: string, turnId: string) => ({
  method: 'turn/completed',
  params: { threadId: nativeId, turn: { id: turnId, status: 'finishedSomehow' } },
});

test('a Codex connection restart rejoins matching managed sessions without replaying input', async () => {
  const fixture = await setup();
  try {
    const running = await startHeldTurn(fixture, 'reconnect-running');
    const finished = await startHeldTurn(fixture, 'reconnect-finished');
    const { thread: idle } = await fixture.create('reconnect-idle');
    const queued = fixture.envelope({
      kind: 'queue',
      threadId: finished.thread.id,
      expectedTurnId: finished.turnId,
      input: { kind: 'text', text: 'Only send this after confirmed completion' },
    });
    expect((await fixture.submit(queued)).delivery).toBe('queued');
    const before = (await fixture.calls()).length;
    await fixture.control({
      disconnectOnce: true,
      holdTurn: true,
      threadStatuses: {
        [running.nativeId]: { type: 'active', activeFlags: [] },
        [finished.nativeId]: { type: 'idle' },
        [idle.nativeId!]: { type: 'idle' },
      },
      threadTurns: {
        [running.nativeId]: [{ id: running.turnId, status: 'inProgress' }],
        [finished.nativeId]: [{ id: finished.turnId, status: 'completed' }],
        [idle.nativeId!]: [],
      },
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(
        async () => {
          // ordinary reads cause the disconnected transport to reconnect
          await fixture.request({ kind: 'usage', provider: 'codex' });
          return (await fixture.calls())
            .slice(before)
            .filter((call) => call.method === 'thread/resume').length;
        },
        { timeout: 2000 },
      )
      .toBe(3);
    expect(await fixture.thread(running.thread.id)).toMatchObject({
      ownership: 'managed',
      state: 'running',
      activeTurnId: running.turnId,
    });
    expect(await fixture.thread(idle.id)).toMatchObject({ ownership: 'managed', state: 'idle' });
    expect(await fixture.receipt(finished.message.id)).toMatchObject({
      delivery: 'acknowledged',
      completion: 'completed',
      result: null,
    });
    await fixture.until(
      () => fixture.receipt(queued.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const resumed = (await fixture.calls()).slice(before);
    expect(resumed.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    for (const call of resumed.filter((call) => call.method === 'thread/resume'))
      expect(call.params).toStrictEqual({ threadId: call.params.threadId, excludeTurns: true });
    await emit(fixture, { holdTurn: true }, [
      {
        method: 'turn/completed',
        params: {
          threadId: running.nativeId,
          turn: { id: running.turnId, status: 'completed' },
        },
      },
    ]);
    await fixture.until(
      () => fixture.receipt(running.message.id),
      (entry) => entry.completion === 'completed',
    );
    expect(await fixture.thread(running.thread.id)).toMatchObject({
      ownership: 'managed',
      activeTurnId: null,
    });
    expect(await fixture.receipt(running.message.id)).toMatchObject({
      completion: 'completed',
      result: null,
    });
  } finally {
    await fixture.close();
  }
});

test('successive Codex connection restarts rejoin once per loss without another turn start', async () => {
  const fixture = await setup();
  try {
    const running = await startHeldTurn(fixture, 'repeated-reconnect');
    for (const count of [1, 2]) {
      await fixture.control({
        ...reads(
          running.nativeId,
          { type: 'active', activeFlags: [] },
          running.turnId,
          'inProgress',
        ),
        disconnectOnce: true,
      });
      await fixture.request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(
          async () =>
            (await fixture.calls()).filter((call) => call.method === 'thread/resume').length,
          { timeout: 2000 },
        )
        .toBe(count);
      await expect
        .poll(async () => (await fixture.thread(running.thread.id)).ownership)
        .toBe('managed');
      expect(await fixture.thread(running.thread.id)).toMatchObject({
        state: 'running',
        activeTurnId: running.turnId,
      });
    }
    expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('Codex reconnect leaves a newer external turn and an unacknowledged send uncertain', async () => {
  const fixture = await setup();
  try {
    const changed = await startHeldTurn(fixture, 'reconnect-external-turn');
    const { thread: unsettled } = await fixture.create('reconnect-unsettled');
    await fixture.control({
      loseOutput: true,
      holdTurn: true,
      threadStatuses: { [changed.nativeId]: { type: 'active', activeFlags: [] } },
      threadTurns: { [changed.nativeId]: [{ id: 'different-native-turn', status: 'inProgress' }] },
    });
    const lost = fixture.envelope({
      kind: 'message',
      threadId: unsettled.id,
      input: { kind: 'text', text: 'Never replay an unacknowledged send' },
    });
    const before = (await fixture.calls()).length;
    await fixture.submit(lost);
    await fixture.until(
      () => fixture.receipt(lost.id),
      (entry) => entry.delivery === 'uncertain',
    );
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(async () =>
        (await fixture.calls())
          .slice(before)
          .some(
            (call) =>
              call.method === 'thread/turns/list' && call.params.threadId === changed.nativeId,
          ),
      )
      .toBe(true);
    await fixture.until(
      () => fixture.thread(changed.thread.id),
      (entry) => entry.ownership === 'uncertain',
    );
    expect(await fixture.thread(unsettled.id)).toMatchObject({
      ownership: 'uncertain',
      state: 'unknown',
    });
    expect(await fixture.receipt(lost.id)).toMatchObject({ delivery: 'uncertain' });
    const calls = (await fixture.calls()).slice(before);
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'thread/resume')).toStrictEqual([]);
  } finally {
    await fixture.close();
  }
});

test.each([
  [{ type: 'future-native-state' }, 'inProgress'],
  [{ type: 'active', activeFlags: [] }, null],
] as const)(
  'Codex reconnect rejects unverified native execution state %o',
  async (status, turnStatus) => {
    const fixture = await setup();
    try {
      const running = await startHeldTurn(fixture, 'reconnect-unknown-state');
      const before = (await fixture.calls()).length;
      await fixture.control({
        disconnectOnce: true,
        holdTurn: true,
        threadStatuses: { [running.nativeId]: status },
        threadTurns: {
          [running.nativeId]: turnStatus ? [{ id: running.turnId, status: turnStatus }] : [],
        },
      });
      await fixture.request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(async () =>
          (await fixture.calls())
            .slice(before)
            .some(
              (call) =>
                call.method === 'thread/turns/list' && call.params.threadId === running.nativeId,
            ),
        )
        .toBe(true);
      expect(await fixture.thread(running.thread.id)).toMatchObject({
        ownership: 'uncertain',
        state: 'unknown',
      });
      expect(
        (await fixture.calls()).slice(before).filter((call) => call.method === 'thread/resume'),
      ).toStrictEqual([]);
    } finally {
      await fixture.close();
    }
  },
);

test('Codex reconnect quarantines a turn that changes while its subscription is rejoined', async () => {
  const fixture = await setup();
  try {
    const running = await startHeldTurn(fixture, 'reconnect-join-race');
    await fixture.control({
      ...reads(running.nativeId, { type: 'active', activeFlags: [] }, running.turnId, 'inProgress'),
      disconnectOnce: true,
      resumeTurns: { [running.nativeId]: [{ id: 'new-turn-during-join', status: 'inProgress' }] },
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(
        async () =>
          (await fixture.calls()).filter((call) => call.method === 'thread/resume').length,
      )
      .toBe(1);
    await expect
      .poll(async () => (await fixture.thread(running.thread.id)).ownership)
      .toBe('uncertain');
    expect((await fixture.calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('a lost Codex turn completion is read back: the turn completes, queued input follows, and a late original changes nothing', async () => {
  const fixture = await setup();
  try {
    const { thread: other } = await fixture.create('other-session');
    const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'lost-completion');
    const queued = fixture.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: turnId,
      input: { kind: 'text', text: 'Next' },
    });
    expect((await fixture.submit(queued)).delivery).toBe('queued');
    const finished = reads(nativeId, { type: 'idle' }, turnId, 'completed');
    await emit(fixture, finished, [lostCompletion(nativeId, turnId)]);
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({ completion: 'completed', result: null });
    await fixture.until(
      () => fixture.receipt(queued.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    const next = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running' && ![null, turnId].includes(entry.activeTurnId),
    );
    // the original notification arriving late leaves the session as reconciled
    await emit(fixture, finished, [
      {
        method: 'turn/completed',
        params: { threadId: nativeId, turn: { id: turnId, status: 'completed' } },
      },
    ]);
    await fixture.request({ kind: 'usage', provider: 'codex' });
    expect(await fixture.thread(thread.id)).toMatchObject({
      ownership: 'managed',
      state: 'running',
      activeTurnId: next.activeTurnId,
    });
    // another session keeps working throughout
    await fixture.control({});
    const elsewhere = fixture.envelope({
      kind: 'message',
      threadId: other.id,
      input: { kind: 'text', text: 'Elsewhere' },
    });
    await fixture.submit(elsewhere);
    await fixture.until(
      () => fixture.receipt(elsewhere.id),
      (entry) => entry.completion === 'completed',
    );
  } finally {
    await fixture.close();
  }
});

test("a Codex turn completion arriving after its read-back fills in the turn's result, and every session keeps working", async () => {
  const fixture = await setup();
  try {
    const { thread: other } = await fixture.create('other-session');
    const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'late-result');
    // a discarded message leads to a read that finds the turn already saved as completed
    await fixture.control({
      holdTurn: true,
      threadStatuses: { [nativeId]: { type: 'idle' } },
      threadTurns: {
        [nativeId]: [
          { id: turnId, status: 'completed', startedAt: 1_800_000_001, completedAt: null },
        ],
        [other.nativeId!]: [],
      },
      emitOnce: true,
      emitOversized: 1,
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({ completion: 'completed', result: null });
    // the completion itself follows, carrying the result HQ captured
    await emit(fixture, { holdTurn: true }, [
      {
        method: 'turn/completed',
        params: { threadId: nativeId, turn: { id: turnId, status: 'completed' } },
      },
    ]);
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.result !== null,
      ),
    ).toMatchObject({ completion: 'completed', result: { state: 'completed' } });
    expect(await fixture.thread(thread.id)).toMatchObject({ ownership: 'managed' });
    await fixture.control({});
    await sendMessage(fixture, other.id);
    await sendMessage(fixture, thread.id);
  } finally {
    await fixture.close();
  }
});

test("a lost start of HQ's own Codex turn keeps its session managed, and the turn completes", async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('lost-start');
    const nativeId = thread.nativeId!;
    const turns = (status: string) => ({
      [nativeId]: [{ id: 'native-turn-1', status, startedAt: 1_800_000_001, completedAt: null }],
    });
    await fixture.control({
      holdTurn: true,
      loseTurnStarted: true,
      threadStatuses: { [nativeId]: { type: 'active', activeFlags: [] } },
      threadTurns: turns('inProgress'),
    });
    const message = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Start' },
    });
    await fixture.submit(message);
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running' && entry.activeTurnId === 'native-turn-1',
    );
    // the turn ends: Codex sends its completion and reports the session idle
    await emit(
      fixture,
      {
        holdTurn: true,
        threadStatuses: { [nativeId]: { type: 'idle' } },
        threadTurns: turns('completed'),
      },
      [
        {
          method: 'turn/completed',
          params: { threadId: nativeId, turn: { id: 'native-turn-1', status: 'completed' } },
        },
        {
          method: 'thread/status/changed',
          params: { threadId: nativeId, status: { type: 'idle' } },
        },
      ],
    );
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({
      delivery: 'acknowledged',
      completion: 'completed',
      result: { state: 'completed' },
    });
    expect(await fixture.thread(thread.id)).toMatchObject({ ownership: 'managed' });
  } finally {
    await fixture.close();
  }
});

test("a watched Codex turn's own completion arriving with Codex reporting it idle settles it once, and every session keeps working", async () => {
  const fixture = await setup();
  try {
    const { thread: other } = await fixture.create('other-session');
    const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'watched-end');
    const turns = (status: string) => ({
      [nativeId]: [{ id: turnId, status, startedAt: 1_800_000_001, completedAt: null }],
      [other.nativeId!]: [],
    });
    await fixture.control({
      holdTurn: true,
      threadStatuses: { [nativeId]: { type: 'active', activeFlags: [] } },
      threadTurns: turns('inProgress'),
      emitOnce: true,
      emitOversized: 1,
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect.poll(() => readCalls(fixture, other.nativeId!)).toBe(1);
    // the turn ends normally: its completion and the idle status come together
    await emit(
      fixture,
      {
        holdTurn: true,
        threadStatuses: { [nativeId]: { type: 'idle' } },
        threadTurns: turns('completed'),
      },
      [
        {
          method: 'turn/completed',
          params: { threadId: nativeId, turn: { id: turnId, status: 'completed' } },
        },
        {
          method: 'thread/status/changed',
          params: { threadId: nativeId, status: { type: 'idle' } },
        },
      ],
    );
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({ completion: 'completed' });
    expect(await fixture.thread(thread.id)).toMatchObject({ ownership: 'managed' });
    await fixture.control({});
    await sendMessage(fixture, other.id);
    await sendMessage(fixture, thread.id);
  } finally {
    await fixture.close();
  }
});

test.each([
  ['finished', 'completed'],
  ['still running', 'inProgress'],
])(
  'a lost Codex turn completion whose turn still reads as running is read once more after 2 seconds (%s)',
  async (_label, secondStatus) => {
    startHoldingDelays(2);
    const fixture = await setup();
    try {
      const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'lagging-history');
      const active = { type: 'active', activeFlags: [] };
      await emit(fixture, reads(nativeId, active, turnId, 'inProgress'), [
        lostCompletion(nativeId, turnId),
      ]);
      // the re-check found the turn running and waits to read it once more
      await expect.poll(() => countHeldDelays(2)).toBe(1);
      expect(await fixture.thread(thread.id)).toMatchObject({ ownership: 'managed' });
      await fixture.control(
        reads(
          nativeId,
          secondStatus === 'completed' ? { type: 'idle' } : active,
          turnId,
          secondStatus,
        ),
      );
      expect(releaseHeldDelays(2)).toBe(1);
      if (secondStatus === 'completed')
        expect(
          await fixture.until(
            () => fixture.receipt(message.id),
            (entry) => entry.completion !== null,
          ),
        ).toMatchObject({ completion: 'completed' });
      else
        await fixture.until(
          () => fixture.thread(thread.id),
          (entry) => entry.ownership === 'uncertain',
        );
    } finally {
      stopHoldingDelays();
      await fixture.close();
    }
  },
);

test('a saved turn still in progress on an idle Codex session is read again, and completes as Codex finally saves it', async () => {
  startHoldingDelays(2);
  const fixture = await setup();
  try {
    const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'idle-in-progress');
    const queued = fixture.envelope({
      kind: 'queue',
      threadId: thread.id,
      expectedTurnId: turnId,
      input: { kind: 'text', text: 'Next' },
    });
    await fixture.submit(queued);
    // the idle status would infer an interruption, which a live re-check doesn't trust
    await emit(fixture, reads(nativeId, { type: 'idle' }, turnId, 'inProgress'), [
      lostCompletion(nativeId, turnId),
    ]);
    await expect.poll(() => countHeldDelays(2)).toBe(1);
    await fixture.control(reads(nativeId, { type: 'idle' }, turnId, 'completed'));
    releaseHeldDelays(2);
    expect(
      await fixture.until(
        () => fixture.receipt(message.id),
        (entry) => entry.completion !== null,
      ),
    ).toMatchObject({ completion: 'completed' });
    await fixture.until(
      () => fixture.receipt(queued.id),
      (entry) => entry.delivery === 'acknowledged',
    );
  } finally {
    stopHoldingDelays();
    await fixture.close();
  }
});

test.each([
  ['a lost turn completion whose read fails', 'read-failure'],
  ['a lost approval resolution', 'approval'],
])('%s makes the Codex session uncertain', async (_label, kind) => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('uncertain-session');
    await fixture.control({
      prompt: {
        method: 'item/commandExecution/requestApproval',
        params: {
          startedAtMs: Date.now(),
          command: 'echo needs-approval',
          cwd: fixture.workspaceRoot,
          availableDecisions: ['accept', 'cancel'],
        },
      },
    });
    const message = fixture.envelope({
      kind: 'message',
      threadId: thread.id,
      input: { kind: 'text', text: 'Run it' },
    });
    await fixture.submit(message);
    const waiting = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'waiting-approval',
    );
    const nativeId = thread.nativeId!;
    const turnId = waiting.activeTurnId!;
    const active = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await emit(
      fixture,
      {
        ...reads(nativeId, active, turnId, 'inProgress'),
        ...(kind === 'read-failure' ? { failRead: true } : {}),
      },
      [
        kind === 'read-failure'
          ? lostCompletion(nativeId, turnId)
          : {
              method: 'serverRequest/resolved',
              params: { threadId: nativeId, requestId: { unexpected: true } },
            },
      ],
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.ownership === 'uncertain',
    );
    const approvals = await fixture.request({ kind: 'approvals', threadId: thread.id });
    expect(approvals).toMatchObject({
      result: { data: [expect.objectContaining({ state: 'expired' })] },
    });
  } finally {
    await fixture.close();
  }
});

test('a re-check whose read Codex holds open leaves other sessions working meanwhile', async () => {
  const fixture = await setup();
  try {
    const { thread: other } = await fixture.create('other-session');
    const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'held-read');
    const finished = reads(nativeId, { type: 'idle' }, turnId, 'completed');
    await emit(fixture, { ...finished, holdReadThread: nativeId, holdTurn: false }, [
      lostCompletion(nativeId, turnId),
    ]);
    const elsewhere = fixture.envelope({
      kind: 'message',
      threadId: other.id,
      input: { kind: 'text', text: 'Elsewhere' },
    });
    await fixture.submit(elsewhere);
    await fixture.until(
      () => fixture.receipt(elsewhere.id),
      (entry) => entry.completion === 'completed',
    );
    // the held session's re-check is still waiting on its read
    expect(await fixture.receipt(message.id)).toMatchObject({ completion: null });
    await fixture.control({ ...finished, holdTurn: false });
    await fixture.until(
      () => fixture.receipt(message.id),
      (entry) => entry.completion === 'completed',
    );
  } finally {
    await fixture.close();
  }
});

test.each([
  ['malformed-item', 'gap'],
  ['malformed-delta', 'gap'],
  ['malformed-turn', 'uncertain'],
  ['malformed-resolution', 'uncertain'],
  ['contradictory-completion', 'uncertain'],
])(
  '%s native events leave the shared Codex connection open, affecting only their session (%s)',
  async (scenario, outcome) => {
    const fixture = await setup();
    try {
      const { thread: other } = await fixture.create('other-session');
      const { thread, nativeId, turnId } = await startHeldTurn(fixture, 'malformed-events');
      const malformed: Record<string, { method: string; params: unknown }> = {
        'malformed-turn': {
          method: 'turn/completed',
          params: { threadId: nativeId, turn: { status: 'completed' } },
        },
        'malformed-item': {
          method: 'item/completed',
          params: {
            threadId: nativeId,
            turnId,
            item: { type: 'agentMessage', text: 'Missing identity' },
          },
        },
        'malformed-delta': {
          method: 'item/agentMessage/delta',
          params: { threadId: nativeId, turnId, itemId: 'invalid-delta', delta: 42 },
        },
        'malformed-resolution': {
          method: 'serverRequest/resolved',
          params: { threadId: nativeId, requestId: null },
        },
        'contradictory-completion': {
          method: 'turn/completed',
          params: { threadId: nativeId, turn: { id: turnId, status: 'inProgress' } },
        },
      };
      // the daemon's saved history shows another turn, which a re-check can't reconcile
      await emit(fixture, { holdTurn: true }, [malformed[scenario]!]);
      if (outcome === 'gap') {
        await expect
          .poll(async () => {
            const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
            return live.kind === 'live-items' && live.result.hasGap;
          })
          .toBe(true);
        expect(await fixture.thread(thread.id)).toMatchObject({
          state: 'running',
          ownership: 'managed',
          activeTurnId: turnId,
        });
      } else
        await fixture.until(
          () => fixture.thread(thread.id),
          (entry) => entry.ownership === 'uncertain',
        );
      // the connection every Codex session shares stays open
      await fixture.control({});
      const elsewhere = fixture.envelope({
        kind: 'message',
        threadId: other.id,
        input: { kind: 'text', text: 'Elsewhere' },
      });
      await fixture.submit(elsewhere);
      await fixture.until(
        () => fixture.receipt(elsewhere.id),
        (entry) => entry.completion === 'completed',
      );
      expect(await fixture.thread(other.id)).toMatchObject({ ownership: 'managed' });
    } finally {
      await fixture.close();
    }
  },
);

const readCalls = async (fixture: Awaited<ReturnType<typeof setup>>, nativeId: string) =>
  (await fixture.calls()).filter(
    (call) => call.method === 'thread/read' && call.params.threadId === nativeId,
  ).length;
const sendMessage = async (fixture: Awaited<ReturnType<typeof setup>>, threadId: string) => {
  const message = fixture.envelope({
    kind: 'message',
    threadId,
    input: { kind: 'text', text: 'Still here' },
  });
  await fixture.submit(message);
  return fixture.until(
    () => fixture.receipt(message.id),
    (entry) => entry.completion === 'completed',
  );
};

test.each([
  ['finishes', 'completed'],
  ['never settles', 'inProgress'],
])(
  'an oversized Codex message keeps a running turn watched and idle sessions untouched, and Codex reporting it idle settles the turn whose end it may have held (%s)',
  async (_label, savedStatus) => {
    startHoldingDelays(2);
    const fixture = await setup();
    try {
      const { thread: first } = await fixture.create('idle-one');
      const { thread: second } = await fixture.create('idle-two');
      const { thread, message, nativeId, turnId } = await startHeldTurn(fixture, 'watched');
      const turns = (status: string) => ({
        [nativeId]: [{ id: turnId, status, startedAt: 1_800_000_001, completedAt: null }],
        [first.nativeId!]: [],
        [second.nativeId!]: [],
      });
      await fixture.control({
        holdTurn: true,
        threadStatuses: { [nativeId]: { type: 'active', activeFlags: [] } },
        threadTurns: turns('inProgress'),
        emitOnce: true,
        emitOversized: 1,
      });
      await fixture.request({ kind: 'usage', provider: 'codex' });
      await expect.poll(() => readCalls(fixture, second.nativeId!)).toBe(1);
      // the running turn continues, and the idle sessions keep their ownership and take input
      expect(await fixture.thread(thread.id)).toMatchObject({
        state: 'running',
        ownership: 'managed',
        activeTurnId: turnId,
      });
      await fixture.control({ threadTurns: turns('inProgress') });
      await sendMessage(fixture, first.id);
      await sendMessage(fixture, second.id);
      // the fixture's history never holds their turns, so each turn's own read waits to read again
      await expect.poll(() => countHeldDelays(2)).toBe(2);
      releaseHeldDelays(2);
      // Codex reports the watched session idle: its turn's end may have been the lost message
      await emit(
        fixture,
        {
          holdTurn: true,
          threadStatuses: { [nativeId]: { type: 'idle' } },
          threadTurns: turns(savedStatus),
        },
        [
          {
            method: 'thread/status/changed',
            params: { threadId: nativeId, status: { type: 'idle' } },
          },
        ],
      );
      if (savedStatus === 'completed')
        expect(
          await fixture.until(
            () => fixture.receipt(message.id),
            (entry) => entry.completion !== null,
          ),
        ).toMatchObject({ completion: 'completed' });
      else {
        await expect.poll(() => countHeldDelays(2)).toBe(1);
        releaseHeldDelays(2);
        await fixture.until(
          () => fixture.thread(thread.id),
          (entry) => entry.ownership === 'uncertain',
        );
      }
    } finally {
      stopHoldingDelays();
      await fixture.close();
    }
  },
);

test('a burst of oversized Codex messages re-checks sessions one read at a time, once each, while actions keep working', async () => {
  const fixture = await setup();
  try {
    const sessions = [];
    for (const name of ['burst-a', 'burst-b', 'burst-c'])
      sessions.push((await fixture.create(name)).thread);
    const [held, ...others] = sessions.map((session) => session.nativeId!);
    const threadTurns = Object.fromEntries(sessions.map((session) => [session.nativeId!, []]));
    await fixture.control({
      holdReadThread: held,
      threadTurns,
      emitOnce: true,
      emitOversized: 2,
    });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect.poll(() => readCalls(fixture, held!)).toBe(1);
    // while the first read is held open, no other re-check reads
    for (const nativeId of others) expect(await readCalls(fixture, nativeId)).toBe(0);
    // a session created and messaged during the burst works
    const { thread: during } = await fixture.create('during-burst');
    await sendMessage(fixture, during.id);
    await fixture.control({ threadTurns });
    // the held session reads once more for the discard that came while it ran; the others once
    await expect.poll(() => readCalls(fixture, held!)).toBe(2);
    for (const nativeId of others) await expect.poll(() => readCalls(fixture, nativeId)).toBe(1);
    for (const session of sessions)
      expect(await fixture.thread(session.id)).toMatchObject({ ownership: 'managed' });
  } finally {
    await fixture.close();
  }
});

test("a lost turn end waiting for its 2-second re-read holds back no other session's re-check", async () => {
  startHoldingDelays(2);
  const fixture = await setup();
  try {
    const { thread: idle } = await fixture.create('idle-session');
    const { message, nativeId, turnId } = await startHeldTurn(fixture, 'waiting-reread');
    const running = (status: string) => ({
      holdTurn: true,
      threadStatuses: { [nativeId]: { type: 'active', activeFlags: [] } },
      threadTurns: {
        [nativeId]: [{ id: turnId, status, startedAt: 1_800_000_001, completedAt: null }],
        [idle.nativeId!]: [],
      },
    });
    await emit(fixture, running('inProgress'), [lostCompletion(nativeId, turnId)]);
    await expect.poll(() => countHeldDelays(2)).toBe(1);
    await fixture.control({ ...running('inProgress'), emitOnce: true, emitOversized: 1 });
    await fixture.request({ kind: 'usage', provider: 'codex' });
    await expect.poll(() => readCalls(fixture, idle.nativeId!)).toBe(1);
    expect(countHeldDelays(2)).toBe(1);
    await fixture.control(running('completed'));
    releaseHeldDelays(2);
    await fixture.until(
      () => fixture.receipt(message.id),
      (entry) => entry.completion === 'completed',
    );
  } finally {
    stopHoldingDelays();
    await fixture.close();
  }
});

test('a response over the frame limit is discarded, leaving its request to fail at its deadline while the connection stays open', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('oversized-response');
    // the discard re-checks the idle session, whose saved history has no turns
    const threadTurns = { [thread.nativeId!]: [] };
    await fixture.control({ oversizeResponseTo: 'account/rateLimits/read', threadTurns });
    const startedAt = Date.now();
    const usage = await fixture
      .request({ kind: 'usage', provider: 'codex' })
      .catch((error) => error);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
    expect(usage).toMatchObject({ kind: 'usage', result: { state: 'unavailable' } });
    await fixture.control({ threadTurns });
    await sendMessage(fixture, thread.id);
    expect(await fixture.thread(thread.id)).toMatchObject({ ownership: 'managed' });
  } finally {
    await fixture.close();
  }
  // the request waits out the native connection's 30-second response deadline on purpose
}, 45_000);

// the durable native observations the runtime recorded, by which it recognizes a repeated one
const countEvents = (stateRoot: string): number => {
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    return z
      .object({ count: z.number() })
      .parse(database.prepare('SELECT count(*) AS count FROM agent_hq_event').get()).count;
  } finally {
    database.close();
  }
};

test('live items stay in memory: a burst of them records nothing and leaves control running, while a repeated turn start is still recognized', async () => {
  const fixture = await setup();
  try {
    const { thread, nativeId, turnId } = await startHeldTurn(fixture, 'items-in-memory');
    const recorded = countEvents(fixture.stateRoot);
    const startedAt = 1_800_000_000 + Number(/^native-turn-(\d+)$/.exec(turnId)![1]);
    /*
     * More items than a provider's lane holds, the turn's start again, and the resolution of a
     * request no approval waits on, the one new observation, which the lane persists last.
     */
    await emit(fixture, { holdTurn: true }, [
      ...Array.from({ length: 2048 }, (_, index) => ({
        method: 'item/completed',
        params: {
          threadId: nativeId,
          turnId,
          item: { id: `burst-${index}`, type: 'agentMessage', text: 'Streamed' },
        },
      })),
      {
        method: 'turn/started',
        params: { threadId: nativeId, turn: { id: turnId, status: 'inProgress', startedAt } },
      },
      { method: 'serverRequest/resolved', params: { threadId: nativeId, requestId: 'marker' } },
    ]);
    await expect.poll(() => countEvents(fixture.stateRoot), { timeout: 5_000 }).toBe(recorded + 1);
    expect(await fixture.thread(thread.id)).toMatchObject({
      state: 'running',
      ownership: 'managed',
      activeTurnId: turnId,
    });
    // the window holds the newest 128 items of the burst
    const live = await fixture.request({ kind: 'live-items', threadId: thread.id });
    if (live.kind !== 'live-items') throw new Error('wrong response');
    expect(live.result.data).toHaveLength(128);
    expect(live.result.data.at(-1)?.nativeId).toBe('burst-2047');
  } finally {
    await fixture.close();
  }
});

test.each(['codex', 'claude'] as const)(
  'admitting a %s steer or thread-close asks the native CLI nothing about operation support',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const status = await fixture.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime status');
      const submit = async (command: IActionCommand): Promise<IActionReceipt> => {
        const action = { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command };
        const response = await fixture.request({ kind: 'action', action });
        if (response.kind !== 'action') throw new Error('Missing action receipt');
        return response.result;
      };
      const receipt = async (id: string) => {
        const response = await fixture.request({ kind: 'receipt', actionId: id });
        return response.kind === 'receipt' ? response.result : null;
      };
      const thread = async (id: string) => {
        const response = await fixture.request({ kind: 'managed-thread', threadId: id });
        return response.kind === 'managed-thread' ? response.result : null;
      };
      // starting a native process can take seconds while other files run
      const settle = (id: string) =>
        expect
          .poll(async () => (await receipt(id))?.delivery, { timeout: 5_000 })
          .toBe('acknowledged');
      const lines = async (filename: string) =>
        (await readFile(join(fixture.root, filename), 'utf8')).trim().split('\n').filter(Boolean);
      /*
       * What the provider's CLI received, in order: Codex's methods, or the type or control subtype
       * of each message Claude's session and read processes read.
       */
      const nativeCalls = async (): Promise<string[]> =>
        provider === 'codex'
          ? (await lines('calls.jsonl')).map(
              (line) => z.object({ method: z.string() }).parse(JSON.parse(line)).method,
            )
          : (await lines('claude-calls.jsonl')).map((line) => {
              const message = z
                .object({ type: z.string(), request: z.object({ subtype: z.string() }).optional() })
                .parse(JSON.parse(line));
              return message.request?.subtype ?? message.type;
            });
      // the calls a support check makes, which list the models and Codex's skills
      const supportChecks = ['model/list', 'skills/list', 'list_models'];
      const created = await submit({
        kind: 'thread-create',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        name: `${provider}-support`,
      });
      await settle(created.id);
      const threadId = created.threadId!;
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
      else await fixture.control({ holdTurn: true, steer: 'join' });
      const message = await submit({
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Keep working' },
      });
      await settle(message.id);
      const turnId = (await receipt(message.id))!.nativeTurnId!;

      const beforeSteer = await nativeCalls();
      const steer = await submit({
        kind: 'steer',
        threadId,
        expectedTurnId: turnId,
        text: 'Also check the logout path',
      });
      await settle(steer.id);
      // the steer itself is the one native call
      expect((await nativeCalls()).slice(beforeSteer.length)).toStrictEqual([
        provider === 'codex' ? 'turn/steer' : 'user',
      ]);

      const stop = await submit({ kind: 'interrupt', threadId, expectedTurnId: turnId });
      await settle(stop.id);
      await expect
        .poll(async () => (await thread(threadId))?.activeTurnId, { timeout: 5_000 })
        .toBeNull();
      const beforeClose = await nativeCalls();
      const close = await submit({ kind: 'thread-close', threadId });
      await settle(close.id);
      const closeCalls = (await nativeCalls()).slice(beforeClose.length);
      // the interrupted turn's own history read may start Claude's read process meanwhile
      expect(closeCalls.filter((call) => supportChecks.includes(call))).toStrictEqual([]);
      expect(await thread(threadId)).toMatchObject({ state: 'inactive' });
    });
  },
);

test('a create with a first input sends it as the same action, which settles once the input is acknowledged', async () => {
  const fixture = await setup();
  try {
    const action = fixture.envelope({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name: 'first-input',
      input: { kind: 'text', text: 'Start with this task' },
    });
    const admitted = await fixture.submit(action);
    expect(admitted).toMatchObject({
      kind: 'thread-create',
      phase: 'create',
      delivery: 'submitted',
    });
    const { receipt } = await fixture.actionWait(action.id, 'settled');
    expect(receipt).toMatchObject({
      delivery: 'acknowledged',
      phase: 'turn',
      nativeThreadId: 'native-1',
      nativeTurnId: expect.stringMatching(/^native-turn-/),
      queuedInput: null,
    });
    const completed = await fixture.until(
      () => fixture.receipt(action.id),
      (entry) => entry.completion === 'completed' && entry.result !== null,
    );
    expect(completed.result).toMatchObject({ state: 'completed', text: 'Live response' });
    const methods = (await fixture.calls()).map((call) => call.method);
    expect(
      methods.filter((method) =>
        ['thread/start', 'thread/name/set', 'turn/start'].includes(method),
      ),
    ).toStrictEqual(['thread/start', 'thread/name/set', 'turn/start']);
    expect(
      JSON.stringify((await fixture.calls()).find((call) => call.method === 'turn/start')),
    ).toContain('Start with this task');
    const thread = await fixture.thread(admitted.threadId!);
    expect(thread).toMatchObject({ name: 'first-input', state: 'completed', nativeId: 'native-1' });
    // one action holds the whole start
    const actions = await fixture.request({ kind: 'actions', threadId: thread.id });
    expect(actions.result.data.map((entry) => entry.id)).toStrictEqual([action.id]);
    const transitions = (await fixture.request({ kind: 'session-states', limit: 128 })).result.data
      .filter((transition) => transition.threadId === thread.id)
      .map((transition) => transition.reason);
    expect(transitions).toStrictEqual(['opened', 'turn-started', 'turn-completed']);
  } finally {
    await fixture.close();
  }
});

test('a first input Codex refuses leaves its session created and named, needing recovery as a refused message does', async () => {
  const fixture = await setup();
  try {
    await fixture.control({ rejectTurn: true });
    const action = fixture.envelope({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      name: 'refused-input',
      input: { kind: 'text', text: 'A refused first input' },
    });
    const admitted = await fixture.submit(action);
    const { receipt } = await fixture.actionWait(action.id, 'settled');
    expect(receipt).toMatchObject({
      delivery: 'failed',
      failure: 'agent-unavailable',
      phase: 'turn',
      nativeThreadId: 'native-1',
      nativeTurnId: null,
      queuedInput: { text: 'A refused first input' },
    });
    expect(await fixture.thread(admitted.threadId!)).toMatchObject({
      name: 'refused-input',
      nativeId: 'native-1',
      ownership: 'managed',
      state: 'unknown',
    });
    await fixture.control({});
    const further = await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: admitted.threadId!,
        input: { kind: 'text', text: 'Input after the refusal' },
      }),
    );
    expect(further).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
  } finally {
    await fixture.close();
  }
});

test('a create refuses a first input whose skill the folder does not list, before any session starts', async () => {
  const fixture = await setup();
  try {
    await expectToRejectCode(
      fixture.runtime.request({
        kind: 'action',
        action: fixture.envelope({
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'missing-skill',
          input: { kind: 'skill', skillId: 'a'.repeat(64), arguments: '' },
        }),
      }),
      'JG_AGENT_HQ_SKILL_UNAVAILABLE',
    );
    expect((await fixture.calls()).map((call) => call.method)).not.toContain('thread/start');
  } finally {
    await fixture.close();
  }
});

test('a close with interrupt stops the running turn and closes in one action, and closes an idle session as before', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('closing-turn');
    await fixture.control({ holdTurn: true });
    const message = await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'A long task' },
      }),
    );
    const running = await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const close = fixture.envelope({ kind: 'thread-close', threadId: thread.id, interrupt: true });
    expect(await fixture.submit(close)).toMatchObject({
      phase: 'interrupt',
      delivery: 'submitted',
    });
    const { receipt } = await fixture.actionWait(close.id, 'settled');
    expect(receipt).toMatchObject({ delivery: 'acknowledged', phase: 'close' });
    expect(await fixture.thread(thread.id)).toMatchObject({
      state: 'inactive',
      activeTurnId: null,
    });
    expect(await fixture.receipt(message.id)).toMatchObject({ completion: 'interrupted' });
    const calls = (await fixture.calls()).map((call) => call.method);
    const order = ['turn/interrupt', 'thread/backgroundTerminals/clean', 'thread/unsubscribe'];
    expect(calls.filter((method) => order.includes(method))).toStrictEqual(order);
    expect(
      (await fixture.calls()).find((call) => call.method === 'turn/interrupt')?.params,
    ).toMatchObject({ threadId: thread.nativeId, turnId: running.activeTurnId });
    const reasons = (await fixture.request({ kind: 'session-states', limit: 128 })).result.data
      .filter((transition) => transition.threadId === thread.id)
      .map((transition) => transition.reason);
    expect(reasons.slice(-2)).toStrictEqual(['operator-stopped', 'closed']);

    const idle = (await fixture.create('closing-idle')).thread;
    const before = (await fixture.calls()).length;
    const idleClose = fixture.envelope({
      kind: 'thread-close',
      threadId: idle.id,
      interrupt: true,
    });
    expect(await fixture.submit(idleClose)).toMatchObject({ phase: 'clean' });
    expect((await fixture.actionWait(idleClose.id, 'settled')).receipt).toMatchObject({
      delivery: 'acknowledged',
      phase: 'close',
    });
    expect((await fixture.calls()).slice(before).map((call) => call.method)).not.toContain(
      'turn/interrupt',
    );
    expect(await fixture.thread(idle.id)).toMatchObject({ state: 'inactive' });
  } finally {
    await fixture.close();
  }
});

test('thread-delete deletes a Codex session through the daemon with its records, closing one HQ runs first', async () => {
  const fixture = await setup();
  try {
    const remove = (nativeId: string) =>
      fixture.envelope({
        kind: 'thread-delete',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        nativeId,
      });
    // a session HQ closed
    const { action: created, thread: closed } = await fixture.create('closed-session');
    const message = await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: closed.id,
        input: { kind: 'text', text: 'Some work' },
      }),
    );
    await fixture.until(
      () => fixture.receipt(message.id),
      (entry) => entry.completion === 'completed',
    );
    const close = fixture.envelope({ kind: 'thread-close', threadId: closed.id });
    await fixture.submit(close);
    await fixture.actionWait(close.id, 'settled');
    const deletion = remove(closed.nativeId!);
    const deleted = await fixture.submit(deletion);
    expect(deleted).toMatchObject({
      kind: 'thread-delete',
      provider: 'codex',
      phase: 'delete',
      delivery: 'acknowledged',
      threadId: null,
      nativeThreadId: null,
    });
    // a repeated request returns its receipt
    expect(await fixture.submit(deletion)).toStrictEqual(deleted);
    expect(
      (await fixture.calls())
        .filter((call) => call.method === 'thread/delete')
        .map((call) => call.params),
    ).toStrictEqual([{ threadId: closed.nativeId }]);
    expect(
      (await fixture.request({ kind: 'managed-thread', threadId: closed.id })).result,
    ).toBeNull();
    for (const id of [created.id, message.id, close.id])
      expect((await fixture.request({ kind: 'receipt', actionId: id })).result).toBeNull();

    // a session HQ runs is cleaned and closed by the same action, then deleted
    const { thread: running } = await fixture.create('running-session');
    const before = (await fixture.calls()).length;
    expect(await fixture.submit(remove(running.nativeId!))).toMatchObject({
      phase: 'delete',
      delivery: 'acknowledged',
    });
    expect((await fixture.calls()).slice(before).map((call) => call.method)).toStrictEqual([
      'thread/backgroundTerminals/clean',
      'thread/backgroundTerminals/list',
      'thread/unsubscribe',
      'thread/delete',
    ]);
    expect(
      (await fixture.request({ kind: 'managed-thread', threadId: running.id })).result,
    ).toBeNull();

    // a session HQ doesn't manage, which Codex reads to check its folder
    const external = await fixture.submit(remove('thread-1023'));
    expect(external).toMatchObject({ delivery: 'acknowledged', threadId: null });
    const listed = await fixture.request({
      kind: 'threads',
      providers: ['codex'],
      workspaceRoots: [fixture.workspaceRoot],
      limit: 1,
    });
    expect(listed.result.data[0]?.nativeId).toBe('thread-1022');
    // the transition log keeps what the deleted sessions went through
    expect(
      (await fixture.request({ kind: 'session-states', limit: 128 })).result.data.some(
        (transition) => transition.threadId === closed.id,
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('thread-delete refuses a running session, a folder outside the allowed roots and a session in another folder', async () => {
  const fixture = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'jg-hq-outside-'));
  try {
    const { thread } = await fixture.create('busy-session');
    await fixture.control({ holdTurn: true });
    await fixture.submit(
      fixture.envelope({
        kind: 'message',
        threadId: thread.id,
        input: { kind: 'text', text: 'Keep working' },
      }),
    );
    await fixture.until(
      () => fixture.thread(thread.id),
      (entry) => entry.state === 'running',
    );
    const remove = (workspaceRoot: string) =>
      fixture.runtime.request({
        kind: 'action',
        action: fixture.envelope({
          kind: 'thread-delete',
          provider: 'codex',
          workspaceRoot,
          nativeId: thread.nativeId!,
        }),
      });
    await expectToRejectCode(remove(fixture.workspaceRoot), 'JG_AGENT_HQ_REQUEST_INVALID');
    await expectToRejectCode(remove(outside), 'JG_AGENT_HQ_TARGET_FORBIDDEN');
    const nested = join(fixture.workspaceRoot, 'nested');
    await mkdir(nested);
    await expectToRejectCode(remove(nested), 'JG_AGENT_HQ_REQUEST_INVALID');
    // nothing was recorded or sent for the refusals
    expect((await fixture.calls()).map((call) => call.method)).not.toContain('thread/delete');
    expect(
      (await fixture.request({ kind: 'actions', threadId: thread.id })).result.data.map(
        (action) => action.kind,
      ),
    ).not.toContain('thread-delete');
  } finally {
    await fixture.close();
    await rm(outside, { recursive: true });
  }
});

test('a Codex deletion that fails reports PROVIDER_FAILED, records its failure and leaves the session to delete again', async () => {
  const fixture = await setup();
  try {
    const { thread } = await fixture.create('failing-deletion');
    const close = fixture.envelope({ kind: 'thread-close', threadId: thread.id });
    await fixture.submit(close);
    await fixture.actionWait(close.id, 'settled');
    await fixture.control({ deleteFailure: true });
    const deletion = fixture.envelope({
      kind: 'thread-delete',
      provider: 'codex',
      workspaceRoot: fixture.workspaceRoot,
      nativeId: thread.nativeId!,
    });
    await expectToRejectCode(
      fixture.runtime.request({ kind: 'action', action: deletion }),
      'JG_AGENT_HQ_PROVIDER_FAILED',
      'The HQ provider integration failed: The Codex integration failed: Synthetic delete failure',
    );
    expect(await fixture.receipt(deletion.id)).toMatchObject({
      delivery: 'failed',
      phase: 'delete',
      threadId: thread.id,
    });
    expect(await fixture.thread(thread.id)).toMatchObject({ state: 'inactive' });
    // a session Codex never saved, as one created without a turn, counts as deleted
    await fixture.control({ noRollout: [thread.nativeId] });
    expect(
      await fixture.submit(
        fixture.envelope({
          kind: 'thread-delete',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          nativeId: thread.nativeId!,
        }),
      ),
    ).toMatchObject({ delivery: 'acknowledged', threadId: null });
    expect(
      (await fixture.request({ kind: 'managed-thread', threadId: thread.id })).result,
    ).toBeNull();
  } finally {
    await fixture.close();
  }
});

test('thread-delete removes a Claude transcript with its folder and records, and refuses a session a terminal runs', async () => {
  await withClaudeRuntime(async (fixture) => {
    const remove = (nativeId: string) =>
      fixture.runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: fixture.runtime.runtimeEpoch,
          command: {
            kind: 'thread-delete',
            provider: 'claude',
            workspaceRoot: fixture.workspaceRoot,
            nativeId,
          },
        },
      });
    const listed = async () =>
      (
        await fixture.runtime.request({
          kind: 'threads',
          providers: ['claude'],
          workspaceRoots: [fixture.workspaceRoot],
        })
      ).result.data.map((session) => session.nativeId);
    // a session HQ doesn't manage, with the folder beside its transcript
    const external = randomUUID();
    await writeFile(
      fixture.transcript(external),
      `${JSON.stringify(claudeRecord(fixture.workspaceRoot, external))}\n`,
    );
    await mkdir(join(fixture.projectRoot, external, 'subagents'), { recursive: true });
    await writeFile(join(fixture.projectRoot, external, 'subagents', 'agent.jsonl'), '{}\n');
    expect(await listed()).toContain(external);
    expect((await remove(external)).result).toMatchObject({
      kind: 'thread-delete',
      delivery: 'acknowledged',
    });
    await expect(readFile(fixture.transcript(external))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(fixture.projectRoot, external))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await listed()).not.toContain(external);

    // a session HQ runs, idle, is closed and deleted with its records
    const created = await fixture.runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: fixture.runtime.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'claude',
          workspaceRoot: fixture.workspaceRoot,
          name: 'claude-deletion',
        },
      },
    });
    await fixture.runtime.request({
      kind: 'action-wait',
      actionId: created.result.id,
      until: 'settled',
      timeoutMs: 10_000,
    });
    const thread = (
      await fixture.runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! })
    ).result!;
    await expect(readFile(fixture.transcript(thread.nativeId!))).resolves.toBeDefined();
    expect((await remove(thread.nativeId!)).result).toMatchObject({ delivery: 'acknowledged' });
    await expect(readFile(fixture.transcript(thread.nativeId!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await fixture.runtime.request({ kind: 'managed-thread', threadId: thread.id })).result,
    ).toBeNull();

    // a session a terminal runs stays
    const terminal = randomUUID();
    await writeFile(
      fixture.transcript(terminal),
      `${JSON.stringify(claudeRecord(fixture.workspaceRoot, terminal))}\n`,
    );
    await writeFixtureControl(fixture.root, 'claude-agents.json', {
      agents: [
        {
          sessionId: terminal,
          cwd: fixture.workspaceRoot,
          kind: 'interactive',
          status: 'idle',
          pid: process.pid,
        },
      ],
    });
    await fixture.runtime.request({ kind: 'observation-pace', pace: 'live' });
    await expect
      .poll(
        async () =>
          (await fixture.runtime.request({ kind: 'active-sessions' })).result.data.length +
          (
            await fixture.runtime.request({ kind: 'session-states', limit: 128 })
          ).result.data.filter((transition) => transition.nativeId === terminal).length,
      )
      .toBeGreaterThan(0);
    await expectToRejectCode(remove(terminal), 'JG_AGENT_HQ_REQUEST_INVALID');
    await expect(readFile(fixture.transcript(terminal))).resolves.toBeDefined();
  });
});

test('a Claude transcript that cannot be deleted reports PROVIDER_FAILED and stays listed', async () => {
  await withClaudeRuntime(async (fixture) => {
    const nativeId = randomUUID();
    await writeFile(
      fixture.transcript(nativeId),
      `${JSON.stringify(claudeRecord(fixture.workspaceRoot, nativeId))}\n`,
    );
    await chmod(fixture.projectRoot, 0o500);
    try {
      const deletion = {
        id: randomUUID(),
        runtimeEpoch: fixture.runtime.runtimeEpoch,
        command: {
          kind: 'thread-delete' as const,
          provider: 'claude' as const,
          workspaceRoot: fixture.workspaceRoot,
          nativeId,
        },
      };
      await expectToRejectCode(
        fixture.runtime.request({ kind: 'action', action: deletion }),
        'JG_AGENT_HQ_PROVIDER_FAILED',
        'The HQ provider integration failed: EACCES',
      );
      expect(
        (await fixture.runtime.request({ kind: 'receipt', actionId: deletion.id })).result,
      ).toMatchObject({ delivery: 'failed', phase: 'delete' });
      await expect(readFile(fixture.transcript(nativeId))).resolves.toBeDefined();
    } finally {
      await chmod(fixture.projectRoot, 0o700);
    }
  });
});
