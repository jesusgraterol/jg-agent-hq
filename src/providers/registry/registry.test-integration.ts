import { randomUUID } from 'node:crypto';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';

test.each(['codex', 'claude'] as const)(
  'an installation containing only %s still runs that provider and storage reads',
  async (selected) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
      const bin = join(root, 'bin');
      await symlink(process.execPath, join(bin, 'node'));
      await rm(join(bin, selected === 'codex' ? 'claude' : 'codex'));
      vi.stubEnv('PATH', bin);
      const unavailable = selected === 'codex' ? 'claude' : 'codex';
      expect(await runtime.request({ kind: 'capabilities', provider: unavailable })).toMatchObject({
        kind: 'capabilities',
        result: { operations: { create: { state: 'unavailable' } } },
      });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: selected,
            workspaceRoot,
            name: 'one-provider',
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { provider: selected, state: 'idle' } });
      expect(await runtime.request({ kind: 'managed-threads', workspaceRoot })).toMatchObject({
        kind: 'managed-threads',
      });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  'missing diagnostic version metadata and additive initialization fields do not block %s control',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot, control }) => {
      if (provider === 'claude')
        await control({ omitVersion: true, futureMetadata: { label: 'compatible extension' } });
      else
        await writeFixtureControl(root, 'control.json', {
          omitVersion: true,
          futureMetadata: { label: 'compatible extension' },
        });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'thread-create', provider, workspaceRoot, name: 'version-metadata' },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
      expect(await runtime.request({ kind: 'status' })).toMatchObject({
        kind: 'status',
        result: {
          providers: expect.arrayContaining([{ provider, state: 'ready', version: null }]),
        },
      });
    });
  },
);
