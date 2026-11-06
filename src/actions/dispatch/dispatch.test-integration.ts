import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IActionCommand, IActionEnvelope } from 'jg-agent-hq/contracts';
import { createAgentHq, type IWorkspaceDispatchCheckRequest } from 'jg-agent-hq';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  withClaudeRuntime,
  waitForWarmUp,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

const createActions = async (fixture: IClaudeFixture, provider: 'codex' | 'claude') => {
  const { runtime, workspaceRoot } = fixture;
  await waitForWarmUp(runtime);
  const envelope = (command: IActionCommand): IActionEnvelope => ({
    id: randomUUID(),
    runtimeEpoch: runtime.runtimeEpoch,
    command,
  });
  const send = async (command: IActionCommand) =>
    (await runtime.request({ kind: 'action', action: envelope(command) })).result;
  const receipt = async (actionId: string) =>
    (await runtime.request({ kind: 'receipt', actionId })).result;
  const created = await send({
    kind: 'thread-create',
    provider,
    workspaceRoot,
    name: 'dispatch-guard',
  });
  await expect.poll(async () => (await receipt(created.id))?.delivery).toBe('acknowledged');
  const threadId = created.threadId!;
  const thread = async () => (await runtime.request({ kind: 'managed-thread', threadId })).result!;
  const away = join(workspaceRoot, 'part-b');
  await mkdir(away);
  return { envelope, send, receipt, threadId, thread, away };
};

const nativeEffects = async (root: string, provider: 'codex' | 'claude') => {
  const calls = z
    .array(
      z.object({
        method: z.string().optional(),
        type: z.string().optional(),
        request: z.object({ subtype: z.string().optional() }).optional(),
      }),
    )
    .parse(
      (
        await readFile(
          join(root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    );
  return {
    turns: calls.filter((call) => call.method === 'turn/start' || call.type === 'user').length,
    controls: calls.filter((call) => call.request?.subtype === 'set_cwd').length,
  };
};

test('a changed host binding after queue admission refuses the continuation before its native workspace effect', async () => {
  const checks: IWorkspaceDispatchCheckRequest[] = [];
  let binding = '';
  await withClaudeRuntime(
    async (fixture) => {
      binding = join(fixture.workspaceRoot, 'binding.txt');
      await writeFile(binding, 'authorized');
      const api = await createActions(fixture, 'codex');
      await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
      await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Finish preparation' },
      });
      await expect.poll(async () => (await api.thread()).activeTurnId).not.toBeNull();
      const source = (await api.thread()).activeTurnId!;
      const queued = await api.send({
        kind: 'queue',
        threadId: api.threadId,
        expectedTurnId: source,
        input: { kind: 'text', text: 'Run the authorized unit' },
        workspaceChange: {
          expectedWorkspaceRoot: fixture.workspaceRoot,
          workspaceRoot: api.away,
        },
      });
      expect(queued.delivery).toBe('queued');
      expect(checks).toStrictEqual([]);
      await writeFile(binding, 'changed');
      await writeFixtureControl(fixture.root, 'control.json', { completeOnSteer: true });
      await api.send({
        kind: 'steer',
        threadId: api.threadId,
        expectedTurnId: source,
        text: 'End',
      });
      await expect.poll(async () => (await api.receipt(queued.id))?.delivery).toBe('failed');
      expect(await api.receipt(queued.id)).toMatchObject({
        failure: 'state-conflict',
        nativeTurnId: null,
        workspaceTransition: { state: 'failed' },
      });
      expect((await api.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
      expect(checks).toStrictEqual([
        {
          actionId: queued.id,
          threadId: api.threadId,
          provider: 'codex',
          nativeId: (await api.thread()).nativeId,
          workspaceChange: {
            expectedWorkspaceRoot: fixture.workspaceRoot,
            workspaceRoot: api.away,
          },
        },
      ]);
      const calls = z
        .array(
          z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
        )
        .parse(
          (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown),
        );
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
      expect(calls.some((call) => call.params?.cwd === api.away)).toBe(false);
    },
    {
      validateWorkspaceDispatch: async (request) => {
        checks.push(structuredClone(request));
        return (await readFile(binding, 'utf8')) === 'authorized';
      },
    },
  );
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} checks the exact action and a copied intent before permitting one move`, async () => {
    const checks: IWorkspaceDispatchCheckRequest[] = [];
    await withClaudeRuntime(
      async (fixture) => {
        const api = await createActions(fixture, provider);
        const intent = api.envelope({
          kind: 'message',
          threadId: api.threadId,
          input: { kind: 'text', text: 'Continue the same unit' },
          workspaceChange: {
            expectedWorkspaceRoot: fixture.workspaceRoot,
            workspaceRoot: api.away,
          },
        });
        await fixture.runtime.request({ kind: 'action', action: intent });
        await expect.poll(async () => (await api.receipt(intent.id))?.completion).toBe('completed');
        expect(await api.thread()).toMatchObject({ workspaceRoot: api.away });
        expect(checks).toStrictEqual([
          {
            actionId: intent.id,
            threadId: api.threadId,
            provider,
            nativeId: (await api.thread()).nativeId,
            workspaceChange: {
              expectedWorkspaceRoot: fixture.workspaceRoot,
              workspaceRoot: api.away,
            },
          },
        ]);
        await fixture.runtime.request({ kind: 'action', action: intent });
        expect(checks).toHaveLength(1);
        expect((await nativeEffects(fixture.root, provider)).turns).toBe(1);
      },
      {
        validateWorkspaceDispatch: async (request) => {
          checks.push(structuredClone(request));
          request.workspaceChange.workspaceRoot = join(
            request.workspaceChange.workspaceRoot,
            'altered',
          );
          return true;
        },
      },
    );
  });

  test.each(['refused', 'throws'] as const)(
    `${provider} records a %s host check as a failed, unsent move without replaying input`,
    async (outcome) => {
      let checks = 0;
      await withClaudeRuntime(
        async (fixture) => {
          const api = await createActions(fixture, provider);
          const intent = api.envelope({
            kind: 'message',
            threadId: api.threadId,
            input: { kind: 'text', text: 'Do not deliver without authorization' },
            workspaceChange: {
              expectedWorkspaceRoot: fixture.workspaceRoot,
              workspaceRoot: api.away,
            },
          });
          await fixture.runtime.request({ kind: 'action', action: intent });
          await expect.poll(async () => (await api.receipt(intent.id))?.delivery).toBe('failed');
          const receipt = await api.receipt(intent.id);
          expect(receipt).toMatchObject({
            failure: outcome === 'refused' ? 'state-conflict' : 'operation-failed',
            nativeTurnId: null,
            workspaceTransition: { state: 'failed' },
          });
          expect(JSON.stringify(receipt)).not.toContain('Private host diagnostic');
          await fixture.runtime.request({ kind: 'action', action: intent });
          expect(checks).toBe(1);
          expect((await api.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
          expect(await nativeEffects(fixture.root, provider)).toStrictEqual({
            turns: 0,
            controls: 0,
          });
        },
        {
          validateWorkspaceDispatch: async () => {
            checks += 1;
            if (outcome === 'throws') throw new Error('Private host diagnostic');
            return false;
          },
        },
      );
    },
  );
}

test('input-free Claude return is guarded while ordinary messages bypass the host workspace check', async () => {
  let checks = 0;
  await withClaudeRuntime(
    async (fixture) => {
      const api = await createActions(fixture, 'claude');
      const source = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Complete the authorized plan' },
      });
      await expect.poll(async () => (await api.receipt(source.id))?.completion).toBe('completed');
      expect(checks).toBe(0);
      const returned = await api.send({
        kind: 'workspace-change',
        threadId: api.threadId,
        expectedTurnId: (await api.receipt(source.id))!.nativeTurnId!,
        workspaceChange: {
          expectedWorkspaceRoot: fixture.workspaceRoot,
          workspaceRoot: api.away,
        },
      });
      await expect.poll(async () => (await api.receipt(returned.id))?.delivery).toBe('failed');
      expect(await api.receipt(returned.id)).toMatchObject({
        failure: 'state-conflict',
        completion: null,
        nativeTurnId: null,
        workspaceTransition: { state: 'failed' },
      });
      expect(await nativeEffects(fixture.root, 'claude')).toStrictEqual({ turns: 1, controls: 0 });
      expect(checks).toBe(1);
    },
    {
      validateWorkspaceDispatch: async () => {
        checks += 1;
        return false;
      },
    },
  );
});

test('a source interrupted before its queued move never invokes the host check', async () => {
  let checks = 0;
  await withClaudeRuntime(
    async (fixture) => {
      const api = await createActions(fixture, 'codex');
      await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
      await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Source' },
      });
      await expect.poll(async () => (await api.thread()).activeTurnId).not.toBeNull();
      const source = (await api.thread()).activeTurnId!;
      const queued = await api.send({
        kind: 'queue',
        threadId: api.threadId,
        expectedTurnId: source,
        input: { kind: 'text', text: 'Continuation' },
        workspaceChange: { expectedWorkspaceRoot: fixture.workspaceRoot, workspaceRoot: api.away },
      });
      await api.send({ kind: 'interrupt', threadId: api.threadId, expectedTurnId: source });
      await expect.poll(async () => (await api.receipt(queued.id))?.delivery).toBe('canceled');
      expect(checks).toBe(0);
      expect((await api.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
    },
    {
      validateWorkspaceDispatch: async () => {
        checks += 1;
        return true;
      },
    },
  );
});

test('shutdown cancels an unresolved host check and restart never retries its failed workspace effect', async () => {
  let checks = 0;
  let started = false;
  let canceled = false;
  await withClaudeRuntime(
    async (fixture) => {
      const api = await createActions(fixture, 'codex');
      const move = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Guarded' },
        workspaceChange: { expectedWorkspaceRoot: fixture.workspaceRoot, workspaceRoot: api.away },
      });
      await expect.poll(() => started).toBe(true);
      await fixture.runtime.close();
      expect(canceled).toBe(true);
      const restarted = await createAgentHq({
        stateRoot: fixture.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
        validateWorkspaceDispatch: async () => {
          checks += 1;
          return true;
        },
      });
      try {
        await waitForWarmUp(restarted);
        expect(
          (await restarted.request({ kind: 'receipt', actionId: move.id })).result,
        ).toMatchObject({
          delivery: 'failed',
          nativeTurnId: null,
          workspaceTransition: { state: 'failed' },
        });
        expect(checks).toBe(1);
        expect(await nativeEffects(fixture.root, 'codex')).toStrictEqual({ turns: 0, controls: 0 });
      } finally {
        await restarted.close();
      }
    },
    {
      validateWorkspaceDispatch: async (_request, signal) => {
        checks += 1;
        started = true;
        return new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              canceled = true;
              resolve(true);
            },
            { once: true },
          ),
        );
      },
    },
  );
});

// the public host-check deadline really expires; a late permission cannot release native input
test(
  'a host check that outlives 30 seconds fails without a workspace effect',
  { timeout: 40_000 },
  async () => {
    let canceled = false;
    await withClaudeRuntime(
      async (fixture) => {
        const api = await createActions(fixture, 'codex');
        const move = await api.send({
          kind: 'message',
          threadId: api.threadId,
          input: { kind: 'text', text: 'Guarded' },
          workspaceChange: {
            expectedWorkspaceRoot: fixture.workspaceRoot,
            workspaceRoot: api.away,
          },
        });
        await expect
          .poll(async () => (await api.receipt(move.id))?.delivery, { timeout: 35_000 })
          .toBe('failed');
        expect(canceled).toBe(true);
        expect((await api.thread()).workspaceRoot).toBe(fixture.workspaceRoot);
        expect(await nativeEffects(fixture.root, 'codex')).toStrictEqual({ turns: 0, controls: 0 });
      },
      {
        validateWorkspaceDispatch: async (_request, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                canceled = true;
                resolve(true);
              },
              { once: true },
            );
          }),
      },
    );
  },
);
