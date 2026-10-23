// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectToRejectCode } from 'jg-exception/testing';
import { createAgentHq } from 'jg-agent-hq';
import type {
  IActionCommand,
  IActionEnvelope,
  ISkill,
  IManagedThread,
} from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../scripts/test-support/claude-runtime.js';
import { writeFixtureControl } from '../../scripts/test-support/index.js';

const setup = async (fixture: IClaudeFixture, provider: 'codex' | 'claude') => {
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const envelope = (command: IActionCommand): IActionEnvelope => ({
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command,
  });
  const submit = async (action: IActionEnvelope) => {
    const response = await fixture.request({ kind: 'action', action });
    if (response.kind !== 'action') throw new Error('Missing action');
    return response.result;
  };
  const thread = async (id: string): Promise<IManagedThread> => {
    const response = await fixture.request({ kind: 'managed-thread', threadId: id });
    if (response.kind !== 'managed-thread' || !response.result) throw new Error('Missing thread');
    return response.result;
  };
  const receipt = async (id: string) => {
    const response = await fixture.request({ kind: 'receipt', actionId: id });
    if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
    return response.result;
  };
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
  const settled = (id: string) =>
    until(
      () => receipt(id),
      (receipt) => receipt.delivery === 'acknowledged',
    );
  const created = envelope({
    kind: 'thread-create',
    provider,
    workspaceRoot: fixture.workspaceRoot,
    name: 'skill-task',
  });
  const admitted = await submit(created);
  await settled(created.id);
  const managed = await thread(admitted.threadId!);
  const catalog = async (limit = 32, cursor?: string, search?: string) => {
    const response = await fixture.request({
      kind: 'skills',
      threadId: managed.id,
      limit,
      cursor,
      search,
    });
    if (response.kind !== 'skills') throw new Error('Missing catalog');
    return response.result;
  };
  const preview = async (skillId: string, skillArguments = 'example task') => {
    const response = await fixture.request({
      kind: 'skill-preview',
      threadId: managed.id,
      skillId,
      arguments: skillArguments,
    });
    if (response.kind !== 'skill-preview') throw new Error('Missing preview');
    return response.result;
  };
  const calls = async () =>
    z
      .array(
        z.object({
          method: z.string().optional(),
          params: z.unknown().optional(),
          type: z.string().optional(),
          message: z.unknown().optional(),
        }),
      )
      .parse(
        (
          await readFile(
            join(fixture.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
            'utf8',
          )
        )
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
  const inputs = async () => {
    const records = await calls();
    return provider === 'codex'
      ? records
          .filter((record) => record.method === 'turn/start')
          .map(
            (record) =>
              z
                .object({
                  input: z.array(
                    z.object({
                      type: z.string(),
                      text: z.string().optional(),
                      name: z.string().optional(),
                      path: z.string().nullable().optional(),
                    }),
                  ),
                })
                .parse(record.params).input,
          )
      : records
          .filter((record) => record.type === 'user')
          .map((record) => [
            { type: 'text', text: z.object({ content: z.string() }).parse(record.message).content },
          ]);
  };
  const control = (settings: object) =>
    writeFixtureControl(
      fixture.root,
      provider === 'codex' ? 'control.json' : 'claude-control.json',
      settings,
    );
  return {
    envelope,
    submit,
    thread,
    receipt,
    until,
    settled,
    managed,
    catalog,
    preview,
    calls,
    inputs,
    control,
  };
};

test.each(['codex', 'claude'] as const)(
  '%s catalog reads native metadata and previews explicit invocation without inference',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      const page = await api.catalog();
      expect(page.state).toBe('available');
      expect(page.data).toHaveLength(2);
      const skill = page.data.find((skill) => skill.name === 'explicit-skill')!;
      expect(skill.requiresExplicitInvocation).toBeNull();
      expect(skill).toMatchObject(
        provider === 'codex'
          ? {
              kind: 'skill',
              scope: 'user',
              prerequisites: [
                { type: 'mcp', name: 'example', description: 'Native declared prerequisite' },
              ],
            }
          : {
              kind: 'unavailable',
              scope: null,
              path: null,
              argumentHint: '[task]',
              prerequisites: null,
            },
      );
      const preview = await api.preview(skill.id, 'auto exact-plan');
      expect(preview).toStrictEqual({
        state: 'ready',
        skill,
        text: `${provider === 'codex' ? '$' : '/'}explicit-skill auto exact-plan`,
      });
      expect(await api.inputs()).toStrictEqual([]);
      const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
      const result = await promisify(execFile)(
        process.execPath,
        [
          cli,
          'skill-preview',
          '--state-root',
          fixture.stateRoot,
          '--thread-id',
          api.managed.id,
          '--skill-id',
          skill.id,
          '--arguments',
          'auto exact-plan',
        ],
        { timeout: 5000 },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: 'skill-preview',
        result: { state: 'ready', text: preview.text },
      });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s selected skill uses native input and the existing idempotent action receipt',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      const skill = (await api.catalog()).data.find((skill) => skill.name === 'explicit-skill')!;
      const action = api.envelope({
        kind: 'message',
        threadId: api.managed.id,
        input: { kind: 'skill', skillId: skill.id, arguments: 'a precise task' },
      });
      await api.submit(action);
      await api.settled(action.id);
      await api.submit(action);
      const inputs = await api.inputs();
      expect(inputs).toStrictEqual([
        [
          {
            type: 'text',
            text: `${provider === 'codex' ? '$' : '/'}explicit-skill a precise task`,
          },
          ...(provider === 'codex'
            ? [{ type: 'skill', name: 'explicit-skill', path: skill.path }]
            : []),
        ],
      ]);
      expect((await api.receipt(action.id)).kind).toBe('message');
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s busy skill input stays queued and retains its native selection for explicit release',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      const skill = (await api.catalog()).data[0]!;
      await api.control({ holdTurn: true });
      const first = api.envelope({
        kind: 'message',
        threadId: api.managed.id,
        input: { kind: 'text', text: 'Hold this turn' },
      });
      await api.submit(first);
      await api.settled(first.id);
      const active = await api.until(
        () => api.thread(api.managed.id),
        (thread) => thread.state === 'running',
      );
      const input = { kind: 'skill' as const, skillId: skill.id, arguments: 'after this turn' };
      const rejected = await api.submit(
        api.envelope({ kind: 'message', threadId: active.id, input }),
      );
      expect(rejected).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
      const queued = api.envelope({
        kind: 'queue',
        threadId: active.id,
        expectedTurnId: active.activeTurnId!,
        input,
      });
      expect(await api.submit(queued)).toMatchObject({
        delivery: 'queued',
        queuedInput: { skill: { name: skill.name, path: skill.path } },
      });
      expect(await api.inputs()).toHaveLength(1);
      await api.control({});
      const interrupted = api.envelope({
        kind: 'interrupt',
        threadId: active.id,
        expectedTurnId: active.activeTurnId!,
      });
      await api.submit(interrupted);
      await api.settled(interrupted.id);
      await api.until(
        () => api.thread(active.id),
        (thread) => thread.state === 'interrupted',
      );
      expect((await api.receipt(queued.id)).delivery).toBe('queued');
      const release = api.envelope({ kind: 'queue-send', queuedActionId: queued.id });
      await api.submit(release);
      await api.settled(queued.id);
      const inputs = await api.inputs();
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toStrictEqual([
        { type: 'text', text: `${provider === 'codex' ? '$' : '/'}${skill.name} after this turn` },
        ...(provider === 'codex' ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
      ]);
      expect(await api.receipt(queued.id)).toMatchObject({ queuedInput: null });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s missing or unsupported native skills stay explicit and cannot start input',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      expect(await api.preview('0'.repeat(64))).toStrictEqual({
        state: 'missing',
        skill: null,
        text: null,
      });
      await expectToRejectCode(
        api.submit(
          api.envelope({
            kind: 'message',
            threadId: api.managed.id,
            input: { kind: 'skill', skillId: '0'.repeat(64), arguments: '' },
          }),
        ),
        'JG_AGENT_HQ_CLIENT_STATE_CONFLICT',
        'State changed. Refresh before continuing.',
      );
      if (provider === 'claude') {
        expect(await api.inputs()).toStrictEqual([]);
        return;
      }
      await api.control({ skillsFailure: true });
      expect(await api.catalog()).toStrictEqual({
        state: 'unavailable',
        observedAt: null,
        data: [],
        unavailableCount: 0,
        nextCursor: null,
      });
      expect(await api.preview('0'.repeat(64))).toStrictEqual({
        state: 'unavailable',
        skill: null,
        text: null,
      });
      expect(await api.inputs()).toStrictEqual([]);
    });
  },
);

test('Codex disabled skills and partial discovery remain distinguishable from missing skills', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'codex');
    await api.control({ disabledSkill: true, skillErrors: true });
    const page = await api.catalog();
    expect(page).toMatchObject({ state: 'partial', unavailableCount: 1 });
    const skill = page.data.find((skill) => skill.name === 'explicit-skill')!;
    expect(await api.preview(skill.id)).toStrictEqual({ state: 'disabled', skill, text: null });
    await api.control({ wrongSkillRoot: join(fixture.root, 'foreign') });
    expect((await api.catalog()).state).toBe('unavailable');
  });
});

test.each(['codex', 'claude'] as const)(
  '%s inventory pagination is bounded and revision/query guarded across 1,024 skills',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      if (provider === 'claude') await fixture.control({ skillCount: 1024 });
      const api = await setup(fixture, provider);
      await api.control({ skillCount: 1024 });
      const all: ISkill[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.catalog(128, cursor);
        expect(page.data).toHaveLength(128);
        all.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(all.map((skill) => skill.id)).size).toBe(1024);
      expect(all.map((skill) => skill.id)).toStrictEqual(all.map((skill) => skill.id).sort());
      const page = await api.catalog(32);
      expect(page.data).toHaveLength(32);
      expect(page.nextCursor).not.toBeNull();
      await expectToRejectCode(
        api.catalog(32, page.nextCursor!, 'different'),
        'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
        'Request is invalid.',
      );
      await api.control({ skillCount: 1024, skillRevision: true });
      if (provider === 'codex')
        await expectToRejectCode(
          api.catalog(32, page.nextCursor!),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
          'Request is invalid.',
        );
      else expect((await api.catalog(32, page.nextCursor!)).data).toHaveLength(32);
      expect((await api.catalog(128, undefined, 'explicit-skill')).data).toHaveLength(1);
    });
  },
);

test('trusted extra roots reach native loaders without becoming browser configuration', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.close();
    const extra = join(fixture.root, 'extra');
    await mkdir(extra);
    const runtime = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
      codexExtraSkillRoots: [extra],
      claudeAdditionalDirectories: [extra],
    });
    try {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const action = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'claude',
            workspaceRoot: fixture.workspaceRoot,
            name: 'extra-skills',
          },
        },
      });
      if (action.kind !== 'action') throw new Error('Missing action');
      const deadline = Date.now() + 5000;
      for (;;) {
        const receipt = await runtime.request({ kind: 'receipt', actionId: action.result.id });
        if (receipt.kind === 'receipt' && receipt.result?.delivery === 'acknowledged') break;
        if (Date.now() > deadline) throw new Error('Creation timed out');
        await wait(10);
      }
      expect(await readFile(join(fixture.root, 'calls.jsonl'), 'utf8')).toBe('');
      await runtime.request({
        kind: 'threads',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
      });
      const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls).toContainEqual({
        method: 'skills/extraRoots/set',
        params: { extraRoots: [extra] },
      });
      const starts = z.array(z.object({ args: z.array(z.string()) })).parse(
        (await readFile(join(fixture.root, 'claude-starts.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
      expect(starts[0]!.args.slice(-2)).toStrictEqual(['--add-dir', extra]);
      await expectToRejectCode(
        runtime.request(
          JSON.parse(
            JSON.stringify({
              kind: 'skills',
              threadId: action.result.threadId,
              codexExtraSkillRoots: [extra],
            }),
          ),
        ),
        'JG_AGENT_HQ_REQUEST_INVALID',
        'The HQ request is invalid',
      );
    } finally {
      await runtime.close();
    }
  });
});

test('Claude discovery retains an imported native title and never resumes its session', async () => {
  await withClaudeRuntime(async (fixture) => {
    const id = randomUUID();
    await writeFile(
      fixture.transcript(id),
      [
        JSON.stringify(claudeRecord(fixture.workspaceRoot, id)),
        JSON.stringify({
          type: 'custom-title',
          sessionId: id,
          customTitle: 'Review the account settings',
        }),
      ].join('\n') + '\n',
    );
    const before = await readFile(fixture.transcript(id));
    expect(
      await fixture.request({
        kind: 'thread',
        provider: 'claude',
        workspaceRoot: fixture.workspaceRoot,
        nativeId: id,
      }),
    ).toMatchObject({ result: { name: 'Review the account settings', ownership: 'external' } });
    expect(await readFile(fixture.transcript(id))).toStrictEqual(before);
  });
});

test('Claude unsupported startup metadata is unavailable while execution control remains idle', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.control({ skillsFailure: true });
    const api = await setup(fixture, 'claude');
    expect(await api.catalog()).toStrictEqual({
      state: 'unavailable',
      observedAt: null,
      data: [],
      unavailableCount: 0,
      nextCursor: null,
    });
    expect((await api.thread(api.managed.id)).state).toBe('idle');
  });
});

test('Claude startup catalog and observation time refresh only after explicit close and resume', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await setup(fixture, 'claude');
    const before = await api.catalog();
    const message = api.envelope({
      kind: 'message',
      threadId: api.managed.id,
      input: { kind: 'text', text: 'Create native history' },
    });
    await api.submit(message);
    await api.settled(message.id);
    await api.until(
      () => api.thread(api.managed.id),
      (thread) => thread.state === 'completed',
    );
    await api.control({ skillRevision: true });
    expect(await api.catalog()).toStrictEqual(before);
    const close = api.envelope({ kind: 'thread-close', threadId: api.managed.id });
    await api.submit(close);
    await api.settled(close.id);
    expect((await api.catalog()).state).toBe('unavailable');
    const resume = api.envelope({
      kind: 'thread-resume',
      threadId: api.managed.id,
      operatorConfirmation: 'The native controller is closed.',
    });
    await api.submit(resume);
    await api.settled(resume.id);
    const after = await api.catalog();
    expect(after.data.map((skill) => skill.name).sort()).toStrictEqual([
      'changed-explicit-skill',
      'changed-implicit-skill',
    ]);
    expect(after.observedAt!).toBeGreaterThan(before.observedAt!);
  });
});

test('Claude native command tokens retain provider syntax without a guessed skill-name alphabet', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.control({ symbolicCommand: true });
    const api = await setup(fixture, 'claude');
    const skill = (await api.catalog()).data.find((skill) => skill.name === 'native/command')!;
    expect(await api.preview(skill.id, 'exact task')).toMatchObject({
      state: 'ready',
      text: '/native/command exact task',
    });
  });
});

test.each(['codex', 'claude'] as const)(
  '%s automatic next-turn delivery retains the selected skill after native completion',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await setup(fixture, provider);
      const skill = (await api.catalog()).data[0]!;
      await api.control({ holdTurn: true });
      const first = api.envelope({
        kind: 'message',
        threadId: api.managed.id,
        input: { kind: 'text', text: 'Finish this first' },
      });
      await api.submit(first);
      await api.settled(first.id);
      const active = await api.until(
        () => api.thread(api.managed.id),
        (thread) => thread.state === 'running',
      );
      const queued = api.envelope({
        kind: 'queue',
        threadId: active.id,
        expectedTurnId: active.activeTurnId!,
        input: { kind: 'skill', skillId: skill.id, arguments: 'automatic next turn' },
      });
      await api.submit(queued);
      expect(await api.inputs()).toHaveLength(1);
      await api.control(
        provider === 'codex' ? { releaseThreadId: active.nativeId } : { release: true },
      );
      if (provider === 'codex') await api.catalog();
      await api.settled(queued.id);
      const inputs = await api.inputs();
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toStrictEqual([
        {
          type: 'text',
          text: `${provider === 'codex' ? '$' : '/'}${skill.name} automatic next turn`,
        },
        ...(provider === 'codex' ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
      ]);
    });
  },
);

test.each([
  ['codex', 4097, 0],
  ['claude', 4097, 0],
  ['codex', 1024, 1024],
  ['claude', 1024, 1024],
] as const)(
  '%s oversized inventory (%d skills, %d description chars) reports unavailable without disabling control',
  async (provider, skillCount, skillDescriptionSize) => {
    await withClaudeRuntime(async (fixture) => {
      const settings = { skillCount, skillDescriptionSize };
      if (provider === 'claude') await fixture.control(settings);
      const api = await setup(fixture, provider);
      if (provider === 'codex') await api.control(settings);
      expect(await api.catalog()).toStrictEqual({
        state: 'unavailable',
        observedAt: null,
        data: [],
        unavailableCount: 0,
        nextCursor: null,
      });
      expect((await api.thread(api.managed.id)).state).toBe('idle');
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s a native empty catalog is available and malformed or oversized continuation requests are rejected',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      if (provider === 'claude') await fixture.control({ skillCount: 0 });
      const api = await setup(fixture, provider);
      if (provider === 'codex') await api.control({ skillCount: 0 });
      expect(await api.catalog()).toMatchObject({
        state: 'available',
        data: [],
        nextCursor: null,
        observedAt: expect.any(Number),
      });
      await expectToRejectCode(
        api.catalog(129),
        'JG_AGENT_HQ_REQUEST_INVALID',
        'The HQ request is invalid',
      );
      await expectToRejectCode(
        api.catalog(32, 'bad'),
        'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
        'Request is invalid.',
      );
    });
  },
);
