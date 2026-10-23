import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';

import { withClaudeRuntime, writeFixtureControl } from '../../../../scripts/test-support/index.js';

test.each(['codex', 'claude'])(
  '%s model discovery pages native choices and preserves new effort values',
  async (provider) => {
    await withClaudeRuntime(async ({ request, root, control }) => {
      const settings = { modelCount: 256, modelEffort: 'future-effort-value' };
      if (provider === 'claude') await control(settings);
      else await writeFixtureControl(root, 'control.json', settings);
      const first = await request({ kind: 'models', provider, limit: 128 });
      if (first.kind !== 'models') throw new Error('Missing model catalog');
      expect(first.result.data).toHaveLength(128);
      expect(first.result.data[0]).toMatchObject({
        id: 'model-0000',
        efforts: ['future-effort-value'],
      });
      expect(first.result.nextCursor).not.toBeNull();
      const final = await request({
        kind: 'models',
        provider,
        limit: 128,
        cursor: first.result.nextCursor!,
      });
      if (final.kind !== 'models') throw new Error('Missing continuation');
      expect(final.result.data).toHaveLength(128);
      expect(final.result.nextCursor).toBeNull();
      expect(
        new Set([...first.result.data, ...final.result.data].map((model) => model.id)).size,
      ).toBe(256);
      expect(final.result.data.at(-1)?.id).toBe('model-0255');
      await expect(
        request({ kind: 'models', provider, limit: 32, cursor: first.result.nextCursor! }),
      ).rejects.toThrow('Request is invalid');
      await expect(
        request({
          kind: 'models',
          provider: provider === 'claude' ? 'codex' : 'claude',
          limit: 128,
          cursor: first.result.nextCursor!,
        }),
      ).rejects.toThrow('Request is invalid');
    });
  },
);

test('Claude model continuation rejects a changed catalog and duplicate native identities', async () => {
  await withClaudeRuntime(async ({ request, control }) => {
    const first = await request({ kind: 'models', provider: 'claude', limit: 2 });
    if (first.kind !== 'models') throw new Error('Missing catalog');
    await control({ modelRevision: true });
    await expect(
      request({ kind: 'models', provider: 'claude', limit: 2, cursor: first.result.nextCursor! }),
    ).rejects.toThrow('Request is invalid');
    await control({ modelsDuplicate: true });
    await expect(request({ kind: 'models', provider: 'claude' })).rejects.toThrow(
      'Coding agent is unavailable',
    );
  });
});

test.each(['codex', 'claude'])(
  '%s malformed model metadata disables that catalog while ordinary creation remains usable',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime, request, root, workspaceRoot, control }) => {
      if (provider === 'claude') await control({ modelsMalformed: true });
      else await writeFixtureControl(root, 'control.json', { modelsMalformed: true });
      await expect(request({ kind: 'models', provider })).rejects.toThrow(
        'Coding agent is unavailable',
      );
      expect(await request({ kind: 'capabilities', provider })).toMatchObject({
        kind: 'capabilities',
        result: {
          operations: { models: { state: 'unavailable' }, create: { state: 'supported' } },
        },
      });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime');
      const created = await request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'thread-create', provider, workspaceRoot, name: 'catalog-isolation' },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing creation');
      await expect
        .poll(() => request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    });
  },
);

test('an empty native model inventory has one final empty page', async () => {
  await withClaudeRuntime(async ({ request, control }) => {
    await control({ modelCount: 0 });
    expect(await request({ kind: 'models', provider: 'claude' })).toMatchObject({
      kind: 'models',
      result: { provider: 'claude', data: [], nextCursor: null },
    });
  });
});
