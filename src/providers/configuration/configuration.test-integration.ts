// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import type { IActionCommand } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';

test.each(['codex', 'claude'])(
  'native %s settings change on explicit input and an idle restart preserves identity',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime, request, workspaceRoot, root }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime');
      const send = async (command: IActionCommand) => {
        const id = randomUUID();
        const result = await request({
          kind: 'action',
          action: { id, runtimeEpoch: status.result.runtimeEpoch, command },
        });
        if (result.kind !== 'action') throw new Error('Missing action');
        await expect
          .poll(() => request({ kind: 'receipt', actionId: id }))
          .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
        return result.result;
      };
      const settings = {
        model: 'model-0001',
        effort: 'future-effort',
        developerInstructions: 'Use the native instructions.',
        permissionMode: provider === 'claude' ? 'plan' : 'on-request',
      };
      const created = await send({
        kind: 'thread-create',
        provider,
        workspaceRoot,
        name: 'configured',
        settings,
      });
      const threadId = created.threadId!;
      const first = await request({ kind: 'managed-thread', threadId });
      if (first.kind !== 'managed-thread' || !first.result) throw new Error('Missing thread');
      const config = () => request({ kind: 'configuration', provider, workspaceRoot, threadId });
      expect(await config()).toMatchObject({
        kind: 'configuration',
        result: {
          nativeId: first.result.nativeId,
          effective: {
            model: 'model-0001',
            effort: 'future-effort',
            developerInstructions: settings.developerInstructions,
          },
        },
      });
      expect(JSON.stringify(await config())).not.toContain('must-not-leak');
      const message = await send({
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Check changed settings' },
        settings: { model: 'model-0002', effort: 'another-native-effort' },
      });
      await expect
        .poll(() => request({ kind: 'receipt', actionId: message.id }))
        .toMatchObject({ kind: 'receipt', result: { completion: 'completed' } });
      expect(await config()).toMatchObject({
        kind: 'configuration',
        result: { effective: { model: 'model-0002', effort: 'another-native-effort' } },
      });
      const controlFile = provider === 'codex' ? 'control.json' : 'claude-control.json';
      await writeFixtureControl(root, controlFile, { unavailableSettings: true });
      expect(await config()).toMatchObject({
        kind: 'configuration',
        result: { effective: { model: null, effort: null } },
      });
      await writeFixtureControl(root, controlFile, {});
      await send({ kind: 'thread-close', threadId });
      const restartSettings = {
        model: 'model-0003',
        effort: 'restart-effort',
        developerInstructions: 'Changed startup instructions.',
      };
      await send({
        kind: 'thread-resume',
        threadId,
        operatorConfirmation: 'The native controller is closed.',
        settings: restartSettings,
      });
      expect(await request({ kind: 'managed-thread', threadId })).toMatchObject({
        kind: 'managed-thread',
        result: { id: threadId, nativeId: first.result.nativeId, state: 'idle' },
      });
      expect(await config()).toMatchObject({
        kind: 'configuration',
        result: {
          effective: {
            model: 'model-0003',
            effort: 'restart-effort',
            developerInstructions: restartSettings.developerInstructions,
          },
        },
      });
      if (provider === 'claude') {
        const starts = await readFile(join(root, 'claude-starts.jsonl'), 'utf8');
        expect(starts).toContain('--append-system-prompt');
        expect(starts).toContain('Changed startup instructions.');
      }
      await expectToRejectCode(
        request({
          kind: 'configuration',
          provider: provider === 'codex' ? 'claude' : 'codex',
          workspaceRoot,
          threadId,
        }),
        'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      );
    });
  },
);

test('configuration choices use bounded, revision-bound pages and reject changed scope', async () => {
  await withClaudeRuntime(async ({ request, workspaceRoot, root }) => {
    await writeFixtureControl(root, 'control.json', { profileCount: 256 });
    const query = { kind: 'configuration' as const, provider: 'codex', workspaceRoot, limit: 128 };
    const first = await request(query);
    if (first.kind !== 'configuration') throw new Error('Missing configuration');
    expect(first.result.choices).toHaveLength(128);
    const second = await request({ ...query, cursor: first.result.nextCursor! });
    if (second.kind !== 'configuration') throw new Error('Missing continuation');
    expect(second.result.choices).toHaveLength(128);
    const third = await request({ ...query, cursor: second.result.nextCursor! });
    expect(third).toMatchObject({
      kind: 'configuration',
      result: { choices: [{ id: 'profile-0255' }], nextCursor: null },
    });
    expect(
      new Set(
        [...first.result.choices!, ...second.result.choices!].map(
          (choice) => choice.kind + choice.id,
        ),
      ).size,
    ).toBe(256);
    await expectToRejectCode(
      request({ ...query, limit: 64, cursor: first.result.nextCursor! }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
    );
    await writeFixtureControl(root, 'control.json', { profileCount: 256, configRevision: true });
    await expectToRejectCode(
      request({ ...query, cursor: first.result.nextCursor! }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
    );
    await mkdir(join(root, 'outside'));
    await expectToRejectCode(
      request({ ...query, workspaceRoot: join(root, 'outside') }),
      'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
    );
  });
});

test('a configuration-only failure leaves native creation available', async () => {
  await withClaudeRuntime(async ({ runtime, request, workspaceRoot, root }) => {
    await writeFixtureControl(root, 'control.json', { configMalformed: true });
    await expectToRejectCode(
      request({ kind: 'configuration', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
    );
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime');
    const id = randomUUID();
    await request({
      kind: 'action',
      action: {
        id,
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot,
          name: 'still-available',
        },
      },
    });
    await expect
      .poll(() => request({ kind: 'receipt', actionId: id }))
      .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
  });
});

test('missing optional native agents remain unavailable while effective settings and creation work', async () => {
  await withClaudeRuntime(async ({ runtime, request, workspaceRoot, root }) => {
    await writeFixtureControl(root, 'claude-control.json', { agentsUnavailable: true });
    expect(
      await request({ kind: 'configuration', provider: 'claude', workspaceRoot }),
    ).toMatchObject({
      kind: 'configuration',
      result: { choices: null, effective: { model: 'model-0000' } },
    });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime');
    const id = randomUUID();
    await request({
      kind: 'action',
      action: {
        id,
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'claude',
          workspaceRoot,
          name: 'missing-agents',
        },
      },
    });
    await expect
      .poll(() => request({ kind: 'receipt', actionId: id }))
      .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
  });
});

test.each(['settings', 'initialization'])(
  'runtime shutdown confirms the workspace configuration process has exited before releasing ownership: %s',
  async (stage) => {
    await withClaudeRuntime(async ({ runtime, workspaceRoot, root }) => {
      await writeFixtureControl(
        root,
        'claude-control.json',
        stage === 'settings' ? { holdConfiguration: true } : { holdInitialization: true },
      );
      const read = runtime.request({ kind: 'configuration', provider: 'claude', workspaceRoot });
      const settled = read.catch(() => null);
      await expect
        .poll(async () =>
          (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).includes(
            stage === 'settings' ? 'get_settings' : 'initialize',
          ),
        )
        .toBe(true);
      const { pid } = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(join(root, 'claude-pid.json'), 'utf8')));
      try {
        await runtime.close();
        await settled;
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (cause) {
          if (!hasErrorCode(cause, 'ESRCH')) throw cause;
        }
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (cause) {
              if (hasErrorCode(cause, 'ESRCH')) return false;
              throw cause;
            }
          })
          .toBe(false);
      }
    });
  },
);

test('workspace configuration reads bound process growth and shutdown closes every accepted lane', async () => {
  await withClaudeRuntime(async ({ runtime, workspaceRoot, root }) => {
    await writeFixtureControl(root, 'claude-control.json', { holdConfiguration: true });
    const reads = Array.from({ length: 4 }, () =>
      runtime
        .request({ kind: 'configuration', provider: 'claude', workspaceRoot })
        .catch(() => null),
    );
    await expect
      .poll(
        async () =>
          (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).split('get_settings').length -
          1,
      )
      .toBe(4);
    await expectToRejectCode(
      runtime.request({ kind: 'configuration', provider: 'claude', workspaceRoot }),
      'JG_AGENT_HQ_CLAUDE_FAILED',
    );
    expect(
      (await readFile(join(root, 'claude-read-pids.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(4);
    await runtime.close();
    await Promise.all(reads);
  });
});

test('an idle but loaded native Codex thread rejects startup overrides instead of acknowledging ignored changes', async () => {
  await withClaudeRuntime(async ({ runtime, request, workspaceRoot, root }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing status');
    const send = async (command: IActionCommand) => {
      const id = randomUUID();
      const result = await request({
        kind: 'action',
        action: { id, runtimeEpoch: status.result.runtimeEpoch, command },
      });
      if (result.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => request({ kind: 'receipt', actionId: id }))
        .toMatchObject({
          kind: 'receipt',
          result: { delivery: expect.stringMatching(/^(acknowledged|failed)$/) },
        });
      return { id, threadId: result.result.threadId! };
    };
    const source = await send({
      kind: 'thread-create',
      provider: 'codex',
      workspaceRoot,
      name: 'loaded-settings',
    });
    await writeFixtureControl(root, 'control.json', { unsubscribeState: 'idle' });
    await send({ kind: 'thread-close', threadId: source.threadId });
    const resume = await send({
      kind: 'thread-resume',
      threadId: source.threadId,
      operatorConfirmation: 'Other controllers closed.',
      settings: { model: 'model-0003' },
    });
    expect(await request({ kind: 'receipt', actionId: resume.id })).toMatchObject({
      kind: 'receipt',
      result: { delivery: 'failed', failure: 'agent-unavailable' },
    });
    const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
    expect(calls).not.toContain('"method":"thread/resume"');
  });
});
