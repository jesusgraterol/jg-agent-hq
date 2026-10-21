// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentHq } from 'jg-agent-hq';
import type {
  IActionCommand,
  IActionReceipt,
  IHqRequestInput,
  IHandoff,
  IHandoffPhase,
  IHandoffPreview,
  IPlanCommandInput,
  IPlanOperatorAction,
} from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../scripts/test-support/index.js';

const names = ['jg-challenge-session', 'jg-review-session', 'jg-feedback'];
const until = async <T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 5000;
  let result = await read();
  while (!ready(result) && Date.now() < deadline) {
    await wait(10);
    result = await read();
  }
  expect(ready(result), JSON.stringify(result)).toBe(true);
  return result;
};
const setup = async (
  fixture: IClaudeFixture,
  provider: 'codex' | 'claude' = 'codex',
  purpose: 'challenge' | 'review' = 'challenge',
  prepareSource?: (threadId: string, runtimeEpoch: string) => Promise<void>,
) => {
  const writeControl = (filename: 'control.json' | 'claude-control.json', settings: object) =>
    writeFixtureControl(fixture.root, filename, { skillNames: names, ...settings });
  const control = (settings: object) => writeControl('control.json', settings);
  const claudeControl = (settings: object) => writeControl('claude-control.json', settings);
  await control({});
  await claudeControl({});
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime');
  const epoch = status.result.runtimeEpoch;
  const submit = async (command: IActionCommand) => {
    const response = await fixture.request({
      kind: 'action',
      action: { id: randomUUID(), runtimeEpoch: epoch, command },
    });
    if (response.kind !== 'action') throw new Error('Missing action');
    return response.result;
  };
  const receipt = async (id: string): Promise<IActionReceipt> => {
    const response = await fixture.request({ kind: 'receipt', actionId: id });
    if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
    return response.result;
  };
  const settled = (id: string) =>
    until(
      () => receipt(id),
      (result) => result.delivery === 'acknowledged',
    );
  const source = await submit({
    kind: 'thread-create',
    provider,
    workspaceRoot: fixture.workspaceRoot,
    name: 'build-task',
  });
  await settled(source.id);
  const initial = await submit({
    kind: 'message',
    threadId: source.threadId!,
    input: { kind: 'text', text: 'Discuss the selected task without changing files.' },
  });
  await until(
    () => receipt(initial.id),
    (result) => result.completion === 'completed',
  );
  await prepareSource?.(source.threadId!, epoch);
  const command = {
    kind: 'create' as const,
    id: randomUUID(),
    runtimeEpoch: epoch,
    sourceThreadId: source.threadId!,
    purpose,
    commit: null,
  };
  const handoff = async (command: Extract<IHqRequestInput, { kind: 'handoff' }>['command']) => {
    const response = await fixture.request({ kind: 'handoff', command });
    if (response.kind !== 'handoff' || response.result.kind !== 'handoff')
      throw new Error('Missing handoff');
    return response.result.handoff;
  };
  const show = () => handoff({ kind: 'show', id: command.id });
  const preview = async (phase: IHandoffPhase): Promise<IHandoffPreview> => {
    const response = await fixture.request({
      kind: 'handoff',
      command: { kind: 'preview', id: command.id, phase },
    });
    if (response.kind !== 'handoff' || response.result.kind !== 'preview')
      throw new Error('Missing preview');
    return response.result.preview;
  };
  const send = async (phase: IHandoffPhase) => {
    const prepared = await preview(phase);
    expect(prepared.state).toBe('ready');
    return handoff({ kind: 'send', id: command.id, phase, expectedPreviewDigest: prepared.digest });
  };
  await handoff(command);
  const created = await until(
    show,
    (result) => result.creation.delivery === 'delivered' && !!result.targetNativeId,
  );
  const collect = async (): Promise<IHandoff> => {
    const reviewed = await until(show, (result) => result.review.completion === 'completed');
    if (created.targetProvider === 'codex')
      await control({
        items: [
          {
            turnId: reviewed.review.nativeTurnId,
            item: {
              id: 'review-findings',
              type: 'agentMessage',
              text: 'Check the actual implementation before accepting these findings.',
            },
          },
        ],
      });
    const response = await fixture.request({
      kind: 'items',
      provider: created.targetProvider,
      workspaceRoot: fixture.workspaceRoot,
      nativeId: created.targetNativeId!,
      turnId: reviewed.review.nativeTurnId!,
      limit: 128,
    });
    if (response.kind !== 'items') throw new Error('Missing native findings');
    const item = response.result.data.find((item) => item.kind === 'agent-message')!;
    return handoff({
      kind: 'collect',
      id: command.id,
      turnId: reviewed.review.nativeTurnId!,
      itemId: item.nativeId,
      limit: 128,
    });
  };
  return {
    command,
    epoch,
    source,
    initial,
    created,
    handoff,
    show,
    preview,
    send,
    collect,
    control,
    claudeControl,
    submit,
    receipt,
    settled,
  };
};

test.each(['codex', 'claude'] as const)(
  '%s author receives explicitly selected opposite-provider findings and read-only assessment',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      const prepared = await api.preview('review');
      expect(prepared.text).toContain('jg-challenge-session');
      expect(prepared.text).toContain(api.created.source.nativeId);
      expect(prepared.targetThreadId).toBe(api.created.targetThreadId);
      expect((await api.show()).review.delivery).toBe('prepared');
      await api.send('review');
      const collected = await api.collect();
      expect(collected.findings?.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(collected.findings?.text).not.toBe('');
      expect(collected.feedback.delivery).toBe('prepared');
      const feedback = await api.preview('feedback');
      expect(feedback.targetThreadId).toBe(api.source.threadId);
      expect(feedback.text).toContain('jg-feedback');
      expect(feedback.text).toContain(JSON.stringify(collected.findings!.text));
      await api.send('feedback');
      const assessed = await until(
        api.show,
        (result) => result.feedback.completion === 'completed',
      );
      expect(assessed.feedback.delivery).toBe('delivered');
      expect(assessed.source.threadId).toBe(api.source.threadId);
      const approvals = await fixture.request({
        kind: 'approvals',
        threadId: api.source.threadId!,
      });
      expect(approvals).toStrictEqual({ kind: 'approvals', result: [] });
    });
  },
);

test('delivered-work handoff selects jg-review-session without copying the source transcript', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'codex', 'review');
    const preview = await api.preview('review');
    expect(preview.text).toContain('jg-review-session');
    expect(preview.text).not.toContain('Discuss the selected task');
    expect(preview.text).toContain('authoritative native history');
  });
});

test.each([
  ['codex', 'revoked', false],
  ['claude', 'revoked', false],
  ['codex', 'completed', false],
  ['claude', 'completed', false],
  ['codex', 'revoked', true],
  ['claude', 'revoked', true],
] as const)(
  '%s feedback after %s execution (queued %s) grants no implementation authority',
  async (provider, ending, isQueued) => {
    await withClaudeRuntime(async (fixture) => {
      const directory = join(fixture.workspaceRoot, 'feedback-plan');
      await mkdir(directory);
      await writeFile(join(directory, 'plan.md'), '# Plan\nAssess the selected result.\n');
      const target = { directory };
      const operator = (): IPlanOperatorAction => ({
        id: randomUUID(),
        operatorId: 'fixture-operator',
        source: { kind: 'user-message', reference: `fixture-invocation:${randomUUID()}` },
      });
      const plan = async (command: IPlanCommandInput) => {
        const response = await fixture.request({ kind: 'plan', command });
        if (response.kind !== 'plan') throw new Error('Missing plan');
        return response.result;
      };
      const status = async () => {
        const result = await plan({ kind: 'status', target });
        if (result.kind !== 'status') throw new Error('Missing plan status');
        return result.result;
      };
      const initial = await status();
      const expected = initial.revision;
      await plan({ kind: 'finalize', target, expected, action: operator() });
      await plan({
        kind: 'approve',
        target,
        expected,
        action: operator(),
        scope: 'plan',
        presentationHash: initial.inspection.plan,
      });
      const authorization = operator();
      await plan({
        kind: 'authorize',
        target,
        expected,
        action: authorization,
        mode: 'auto',
        milestoneIds: [],
      });
      const scope = {
        kind: 'execution' as const,
        authorizationId: authorization.id,
        milestoneId: null,
        mode: 'auto' as const,
        revision: expected,
      };
      const api = await setup(fixture, provider, 'review', async (threadId, runtimeEpoch) => {
        const submitted = await fixture.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch,
            plan: scope,
            command: {
              kind: 'message',
              threadId,
              input: { kind: 'text', text: 'Verify the approved result.' },
            },
          },
        });
        if (submitted.kind !== 'action') throw new Error('Missing scoped action');
        await until(
          () => fixture.request({ kind: 'receipt', actionId: submitted.result.id }),
          (result) => result.kind === 'receipt' && result.result?.completion === 'completed',
        );
      });
      await api.send('review');
      await api.collect();
      let busy: IActionReceipt | null = null;
      if (isQueued) {
        await api.control({ holdTurn: true });
        await api.claudeControl({ holdTurn: true });
        busy = await api.submit({
          kind: 'message',
          threadId: api.source.threadId!,
          input: { kind: 'text', text: 'Finish the authorized verification.' },
        });
        await api.settled(busy.id);
      }
      if (ending === 'revoked') {
        await plan({ kind: 'revoke', target, expected, action: operator(), scope: 'execution' });
      } else {
        const checked = await promisify(execFile)(
          process.execPath,
          ['--eval', 'process.stdout.write("assessment-ok")'],
          { timeout: 5000 },
        );
        expect(checked.stdout).toBe('assessment-ok');
        await plan({
          kind: 'complete',
          target,
          expected,
          action: operator(),
          milestoneId: null,
          checkouts: [],
          checks: [
            {
              command: 'node --eval \'process.stdout.write("assessment-ok")\'',
              outcome: 'passed',
              reference: 'fixture:assessment-ok',
            },
          ],
        });
      }
      await expect(api.send('feedback')).resolves.toMatchObject({
        source: { threadId: api.source.threadId },
      });
      const feedback = await api.show();
      const receipt = await api.receipt(feedback.feedback.actionId!);
      expect(receipt.planContext).toStrictEqual({
        directory,
        scope: null,
        observedRevision: expected,
      });
      if (isQueued) {
        expect(feedback.feedback.delivery).toBe('queued');
        await api.control({});
        await api.claudeControl({});
        const running = await api.receipt(busy!.id);
        await api.submit({
          kind: 'interrupt',
          threadId: api.source.threadId!,
          expectedTurnId: running.nativeTurnId!,
        });
        await expect
          .poll(async () => {
            const response = await fixture.request({
              kind: 'managed-thread',
              threadId: api.source.threadId!,
            });
            return response.kind === 'managed-thread' && response.result?.activeTurnId === null;
          })
          .toBe(true);
        await api.submit({ kind: 'queue-send', queuedActionId: receipt.id });
      }
      await until(api.show, (result) => result.feedback.completion === 'completed');
      const after = await status();
      expect(after.coordination.execution!.action.id).toBe(authorization.id);
      expect(after.coordination.execution!.revokedBy !== null).toBe(ending === 'revoked');
      expect(after.coordination.completionCount).toBe(ending === 'completed' ? 1 : 0);
      await expect(
        api.submit({
          kind: 'message',
          threadId: api.source.threadId!,
          input: { kind: 'text', text: 'Do more implementation without approval.' },
        }),
      ).rejects.toThrow('State changed. Refresh before continuing.');
      const assessment = await api.preview('feedback');
      await expect(
        api.submit({
          kind: 'message',
          threadId: api.source.threadId!,
          input: { kind: 'skill', skillId: assessment.skillId!, arguments: 'Assess the result.' },
        }),
      ).rejects.toThrow('State changed. Refresh before continuing.');
      await expect(
        fixture.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: api.epoch,
            expectedPlan: { directory, scope: null, observedRevision: expected },
            command: {
              kind: 'message',
              threadId: api.source.threadId!,
              input: {
                kind: 'text',
                text: 'A revision guard alone grants no implementation authority.',
              },
            },
          },
        }),
      ).rejects.toThrow('State changed. Refresh before continuing.');
      await writeFile(join(directory, 'plan.md'), '# Plan\nChanged requirements.\n');
      expect((await api.preview('feedback')).state).toBe('source-changed');
    });
  },
);

test('same creation and simultaneous sends reuse exactly one native thread and input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    await Promise.all([api.handoff(api.command), api.handoff(api.command)]);
    const preview = await api.preview('review');
    const send = {
      kind: 'send' as const,
      id: api.command.id,
      phase: 'review' as const,
      expectedPreviewDigest: preview.digest,
    };
    await Promise.all([api.handoff(send), api.handoff(send), api.handoff(send)]);
    await until(api.show, (result) => result.review.completion === 'completed');
    await api.handoff(send);
    const starts = (await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(starts).toHaveLength(1);
    const calls = (await readFile(join(fixture.root, 'claude-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.type === 'user')).toHaveLength(1);
    await expect(api.handoff({ ...api.command, purpose: 'review' })).rejects.toThrow();
    await expect(api.handoff({ ...send, expectedPreviewDigest: '0'.repeat(64) })).rejects.toThrow();
  });
});

test('busy author keeps feedback queued and never receives a native permission response', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    await api.send('review');
    await api.collect();
    await api.control({
      holdTurn: true,
      prompt: {
        method: 'item/commandExecution/requestApproval',
        params: {
          startedAtMs: Date.now(),
          command: 'echo example',
          cwd: fixture.workspaceRoot,
          availableDecisions: ['decline', 'cancel'],
        },
      },
    });
    const busy = await api.submit({
      kind: 'message',
      threadId: api.source.threadId!,
      input: { kind: 'text', text: 'Keep this turn open for permission.' },
    });
    await api.settled(busy.id);
    await until(
      () => fixture.request({ kind: 'approvals', threadId: api.source.threadId! }),
      (result) => result.kind === 'approvals' && result.result.length === 1,
    );
    const queued = await api.send('feedback');
    expect(queued.feedback.delivery).toBe('queued');
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
    const approvals = await fixture.request({ kind: 'approvals', threadId: api.source.threadId! });
    expect(approvals.kind === 'approvals' && approvals.result[0]?.state).toBe('pending');
    if (approvals.kind !== 'approvals') throw new Error('Missing approvals');
    await api.control({ completeOnReply: true });
    const pending = approvals.result[0]!;
    await api.submit({
      kind: 'native-reply',
      threadId: api.source.threadId!,
      expectedTurnId: pending.nativeTurnId,
      approvalId: pending.id,
      response: { kind: 'decision', decision: 'decline' },
    });
    const delivered = await until(api.show, (result) => result.feedback.completion === 'completed');
    expect(delivered.feedback.delivery).toBe('delivered');
  });
});

test('lost native acknowledgement stays uncertain and retry never starts another input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    await api.control({ loseOutput: true, holdTurn: true });
    const preview = await api.preview('review');
    const send = {
      kind: 'send' as const,
      id: api.command.id,
      phase: 'review' as const,
      expectedPreviewDigest: preview.digest,
    };
    await api.handoff(send);
    const uncertain = await until(api.show, (result) => result.review.delivery === 'uncertain');
    expect(uncertain.review.completion).toBeNull();
    await api.handoff(send);
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect((await api.show()).feedback.delivery).toBe('prepared');
  });
});

test('missing native skills and missing findings remain unavailable without sending text', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    expect((await api.preview('feedback')).state).toBe('findings-unavailable');
    await api.control({ skillNames: ['unrelated'] });
    const preview = await api.preview('review');
    expect(preview.state).toBe('missing-skill');
    await expect(
      api.handoff({
        kind: 'send',
        id: api.command.id,
        phase: 'review',
        expectedPreviewDigest: preview.digest,
      }),
    ).rejects.toThrow();
    expect((await api.show()).review.delivery).toBe('prepared');
  });
});

test.each(['foreign-turn', 'foreign-item', 'user-message', 'oversized'] as const)(
  'findings reject %s rather than trusting client-supplied content',
  async (failure) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, 'claude');
      await api.send('review');
      const reviewed = await until(api.show, (result) => result.review.completion === 'completed');
      const turnId = reviewed.review.nativeTurnId!;
      await api.control({
        items: [
          {
            turnId,
            item: {
              id: 'findings',
              type: failure === 'user-message' ? 'userMessage' : 'agentMessage',
              text: failure === 'oversized' ? 'x'.repeat(8193) : 'Findings',
              content: [{ type: 'text', text: 'User content' }],
            },
          },
        ],
      });
      await expect(
        api.handoff({
          kind: 'collect',
          id: api.command.id,
          turnId: failure === 'foreign-turn' ? 'other-turn' : turnId,
          itemId: failure === 'foreign-item' ? 'other-item' : 'findings',
        }),
      ).rejects.toThrow();
    });
  },
);

test('handoff pages keep finding bodies inside selected reads and preserve seek ordering over 1024 records', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    const ids = Array.from({ length: 1024 }, () => randomUUID())
      .sort()
      .reverse();
    try {
      const row = database.prepare('SELECT intent FROM handoff WHERE id = ?').get(api.command.id)!;
      const template = JSON.parse(String(row.intent));
      database.exec('BEGIN IMMEDIATE');
      database.prepare('DELETE FROM handoff WHERE id = ?').run(api.command.id);
      const insert = database.prepare(
        'INSERT INTO handoff (id, workspace_root, source_thread_id, created_at, intent) VALUES (?, ?, ?, ?, ?)',
      );
      for (const id of ids)
        insert.run(
          id,
          fixture.workspaceRoot,
          api.source.threadId!,
          7,
          JSON.stringify({
            ...template,
            id,
            createdAt: 7,
            creation: { ...template.creation, id: randomUUID() },
            findings: {
              turnId: 'reference-turn',
              itemId: 'reference-item',
              hash: 'a'.repeat(64),
              text: 'x'.repeat(8192),
            },
          }),
        );
      database.exec('COMMIT');
      const page = async (cursor?: string, sourceThreadId = api.source.threadId!) => {
        const response = await fixture.request({
          kind: 'handoff',
          command: {
            kind: 'list',
            workspaceRoot: fixture.workspaceRoot,
            sourceThreadId,
            limit: 128,
            cursor,
          },
        });
        if (response.kind !== 'handoff' || response.result.kind !== 'page')
          throw new Error('Missing handoff page');
        return response.result;
      };
      let current = await page();
      expect(current.data.map((handoff) => handoff.id)).toStrictEqual(ids.slice(0, 128));
      expect(current.data.every((handoff) => handoff.hasFindings && !('findings' in handoff))).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(131_072);
      await expect(page(current.nextCursor!, randomUUID())).rejects.toThrow();
      await expect(page('invalid-cursor')).rejects.toThrow();
      const future = randomUUID();
      insert.run(
        future,
        fixture.workspaceRoot,
        api.source.threadId!,
        8,
        JSON.stringify({
          ...template,
          id: future,
          createdAt: 8,
          creation: { ...template.creation, id: randomUUID() },
        }),
      );
      database.prepare('DELETE FROM handoff WHERE id = ?').run(ids[300]!);
      const seen = current.data.map((handoff) => handoff.id);
      while (current.nextCursor) {
        current = await page(current.nextCursor);
        seen.push(...current.data.map((handoff) => handoff.id));
      }
      expect(seen).toStrictEqual(ids.filter((id) => id !== ids[300]));
      expect(new Set(seen).size).toBe(1023);
      expect((await page(undefined, randomUUID())).data).toStrictEqual([]);
    } finally {
      database.close();
    }
  });
});

test('selected findings keep their immutable reviewer reference after a readable name changes', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    await api.send('review');
    const reviewed = await until(api.show, (result) => result.review.completion === 'completed');
    const renamed = await api.submit({
      kind: 'thread-rename',
      threadId: reviewed.targetThreadId!,
      name: 'review-renamed',
    });
    await api.settled(renamed.id);
    await api.collect();
    const result = await api.show();
    expect(result.targetNativeId).toBe(reviewed.targetNativeId);
    expect((await api.preview('feedback')).text).toContain(reviewed.targetNativeId!);
  });
});

test('review findings are immutable and cannot be collected from a still-running reviewer', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    await api.control({ holdTurn: true });
    await api.send('review');
    const running = await until(api.show, (result) => result.review.delivery === 'delivered');
    await expect(
      api.handoff({
        kind: 'collect',
        id: api.command.id,
        turnId: running.review.nativeTurnId!,
        itemId: 'not-complete',
      }),
    ).rejects.toThrow();
    await api.control({ releaseThreadId: running.targetNativeId });
    await fixture.request({ kind: 'skills', threadId: running.targetThreadId! });
    const first = await api.collect();
    const turnId = first.findings!.turnId;
    await api.control({
      items: [
        {
          turnId,
          item: {
            id: first.findings!.itemId,
            type: 'agentMessage',
            text: 'Changed native content',
          },
        },
      ],
    });
    await expect(
      api.handoff({
        kind: 'collect',
        id: api.command.id,
        turnId,
        itemId: first.findings!.itemId,
        limit: 128,
      }),
    ).rejects.toThrow();
    expect((await api.show()).findings).toStrictEqual(first.findings);
  });
});

test('Git attribution is verified and a later commit invalidates the prepared preview', async () => {
  await withClaudeRuntime(async (fixture) => {
    const run = promisify(execFile);
    const git = (...args: string[]) =>
      run('git', args, { cwd: fixture.workspaceRoot, timeout: 5000 });
    await git('init');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    const api = await setup(fixture);
    const command = { ...api.command, id: randomUUID(), purpose: 'review' as const, commit: head };
    await api.handoff(command);
    await until(
      () => api.handoff({ kind: 'show', id: command.id }),
      (result) => result.creation.delivery === 'delivered',
    );
    const preview = await fixture.request({
      kind: 'handoff',
      command: { kind: 'preview', id: command.id, phase: 'review' },
    });
    expect(
      preview.kind === 'handoff' &&
        preview.result.kind === 'preview' &&
        preview.result.preview.text,
    ).toContain(head);
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'next fixture',
    );
    const changed = await fixture.request({
      kind: 'handoff',
      command: { kind: 'preview', id: command.id, phase: 'review' },
    });
    expect(
      changed.kind === 'handoff' &&
        changed.result.kind === 'preview' &&
        changed.result.preview.state,
    ).toBe('source-changed');
    await expect(api.handoff({ ...command, id: randomUUID() })).rejects.toThrow();
  });
});

test('native rejection is reported as failed delivery without replacement input', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    await api.control({ rejectTurn: true });
    const preview = await api.preview('review');
    const send = {
      kind: 'send' as const,
      id: api.command.id,
      phase: 'review' as const,
      expectedPreviewDigest: preview.digest,
    };
    await api.handoff(send);
    const rejected = await until(api.show, (result) => result.review.delivery === 'failed');
    expect(rejected.review.completion).toBeNull();
    await api.handoff(send);
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});

test('handoff and exact delivery receipts survive restart without resuming or replaying native work', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    const preview = await api.preview('review');
    const send = {
      kind: 'send' as const,
      id: api.command.id,
      phase: 'review' as const,
      expectedPreviewDigest: preview.digest,
    };
    await api.handoff(send);
    await until(api.show, (result) => result.review.completion === 'completed');
    await api.collect();
    const before = await api.show();
    await fixture.runtime.close();
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect(await api.show()).toStrictEqual(before);
      expect((await api.preview('feedback')).state).toBe('target-unavailable');
      await api.handoff(send);
      const calls = (await readFile(join(fixture.root, 'claude-calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.type === 'user')).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});

test('plan edits invalidate preview and the action admission guard without granting plan authority', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    const directory = join(fixture.workspaceRoot, 'selected-plan');
    await mkdir(directory);
    await writeFile(join(directory, 'plan.md'), '# Selected plan\nImplement the agreed task.\n');
    const status = await fixture.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (status.kind !== 'plan' || status.result.kind !== 'status') throw new Error('Missing plan');
    const context = { directory, scope: null, observedRevision: status.result.result.revision };
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database
        .prepare('INSERT INTO thread_plan (thread_id, directory, context) VALUES (?, ?, ?)')
        .run(api.source.threadId!, directory, JSON.stringify(context));
    } finally {
      database.close();
    }
    const command = { ...api.command, id: randomUUID() };
    await api.handoff(command);
    await until(
      () => api.handoff({ kind: 'show', id: command.id }),
      (result) => result.creation.delivery === 'delivered',
    );
    const prepared = await fixture.request({
      kind: 'handoff',
      command: { kind: 'preview', id: command.id, phase: 'review' },
    });
    expect(
      prepared.kind === 'handoff' &&
        prepared.result.kind === 'preview' &&
        prepared.result.preview.state,
    ).toBe('ready');
    await writeFile(join(directory, 'plan.md'), '# Selected plan\nDifferent requirements.\n');
    const changed = await fixture.request({
      kind: 'handoff',
      command: { kind: 'preview', id: command.id, phase: 'review' },
    });
    expect(
      changed.kind === 'handoff' &&
        changed.result.kind === 'preview' &&
        changed.result.preview.state,
    ).toBe('source-changed');
    await expect(
      fixture.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: api.epoch,
          expectedPlan: context,
          command: {
            kind: 'message',
            threadId: api.source.threadId!,
            input: { kind: 'text', text: 'Stale feedback must not be delivered.' },
          },
        },
      }),
    ).rejects.toThrow();
  });
});

test('installed CLI shows a selected handoff and paged inbox through the same IPC owner', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    const run = promisify(execFile);
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const selected = await run(
      process.execPath,
      [cli, 'handoff-show', '--state-root', fixture.stateRoot, '--id', api.command.id],
      { timeout: 5000 },
    );
    expect(JSON.parse(selected.stdout)).toMatchObject({
      kind: 'handoff',
      result: { kind: 'handoff', handoff: { id: api.command.id } },
    });
    const page = await run(
      process.execPath,
      [
        cli,
        'handoffs',
        '--state-root',
        fixture.stateRoot,
        '--workspace-root',
        fixture.workspaceRoot,
        '--limit',
        '1',
      ],
      { timeout: 5000 },
    );
    expect(JSON.parse(page.stdout)).toMatchObject({
      kind: 'handoff',
      result: { kind: 'page', data: [{ id: api.command.id }] },
    });
    await expect(
      run(
        process.execPath,
        [
          cli,
          'handoff-show',
          '--state-root',
          fixture.stateRoot,
          '--id',
          api.command.id,
          '--provider',
          'claude',
        ],
        { timeout: 5000 },
      ),
    ).rejects.toThrow();
  });
});

test('unknown handoff and failed Git attribution preserve their host contracts and safe client mapping', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    await expect(
      fixture.runtime.request({ kind: 'handoff', command: { kind: 'show', id: randomUUID() } }),
    ).rejects.toThrow('The HQ handoff is unavailable');
    await expect(
      fixture.request({ kind: 'handoff', command: { kind: 'show', id: randomUUID() } }),
    ).rejects.toThrow('Requested resource was not found.');
    await expect(
      fixture.runtime.request({
        kind: 'handoff',
        command: { ...api.command, id: randomUUID(), commit: 'a'.repeat(40) },
      }),
    ).rejects.toThrow('The HQ handoff operation failed:');
    await expect(
      fixture.request({
        kind: 'handoff',
        command: { ...api.command, id: randomUUID(), commit: 'a'.repeat(40) },
      }),
    ).rejects.toThrow('Operation could not be completed.');
  });
});

test('attempted native reattachment preserves the original queued feedback target', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture);
    await api.send('review');
    await api.collect();
    await api.control({ holdTurn: true });
    const busy = await api.submit({
      kind: 'message',
      threadId: api.source.threadId!,
      input: { kind: 'text', text: 'Keep the author busy.' },
    });
    await api.settled(busy.id);
    const queued = await api.send('feedback');
    expect(queued.feedback.delivery).toBe('queued');
    await fixture.runtime.close();
    // seed the durable crash state only after the owned native processes have stopped
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database
        .prepare(
          "UPDATE thread SET ownership = 'uncertain', state = 'unknown', runtime_epoch = ? WHERE id = ?",
        )
        .run(api.epoch, api.source.threadId!);
    } finally {
      database.close();
    }
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const status = await restarted.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing restarted runtime');
      const submit = async (command: IActionCommand) => {
        const response = await restarted.request({
          kind: 'action',
          action: { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command },
        });
        if (response.kind !== 'action') throw new Error('Missing restarted action');
        return response.result;
      };
      const recovered = await submit({
        kind: 'thread-recover',
        threadId: api.source.threadId!,
        recovery: { kind: 'attach', nativeId: 'recovered-other-session' },
        operatorConfirmation:
          'Verified the stopped fixture controller and explicitly selected this other native session.',
      });
      expect(recovered.delivery).toBe('failed');
      expect(recovered.failure).toBe('state-conflict');
      const current = await restarted.request({
        kind: 'managed-thread',
        threadId: api.source.threadId!,
      });
      expect(current).toMatchObject({
        kind: 'managed-thread',
        result: { nativeId: api.created.source.nativeId, ownership: 'uncertain' },
      });
      expect((await api.show()).feedback.delivery).toBe('queued');
      const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        calls.filter(
          (call) =>
            call.method === 'turn/start' && call.params.threadId === 'recovered-other-session',
        ),
      ).toStrictEqual([]);
    } finally {
      await restarted.close();
    }
  });
});

test('unreadable native skill metadata remains unavailable rather than claiming the skill is missing', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    await api.control({ skillsFailure: true });
    expect((await api.preview('review')).state).toBe('skill-unavailable');
    expect((await api.show()).review.delivery).toBe('prepared');
  });
});
