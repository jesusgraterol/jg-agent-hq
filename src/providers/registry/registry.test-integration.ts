import { randomUUID } from 'node:crypto';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test, vi } from 'vitest';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';

test.each(['codex', 'claude'] as const)(
  'a runtime started with only %s installed reports the other unavailable and still runs it and storage reads',
  async (selected) => {
    await withClaudeRuntime(async ({ runtime: first, root, stateRoot, workspaceRoot }) => {
      // the runtime starts both CLIs as it starts, so the other one is gone before it does
      await first.close();
      const bin = join(root, 'bin');
      await symlink(process.execPath, join(bin, 'node'));
      await rm(join(bin, selected === 'codex' ? 'claude' : 'codex'));
      vi.stubEnv('PATH', bin);
      const unavailable = selected === 'codex' ? 'claude' : 'codex';
      const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
      try {
        await expect
          .poll(async () => (await runtime.request({ kind: 'status' })).result.providers)
          .toStrictEqual(
            expect.arrayContaining([
              expect.objectContaining({ provider: selected, state: 'ready' }),
              expect.objectContaining({ provider: unavailable, state: 'unavailable' }),
            ]),
          );
        expect(
          (await runtime.request({ kind: 'capabilities', provider: unavailable })).result,
        ).toMatchObject({ operations: { create: { state: 'unavailable' } } });
        const created = await runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: runtime.runtimeEpoch,
            command: {
              kind: 'thread-create',
              provider: selected,
              workspaceRoot,
              name: 'one-provider',
            },
          },
        });
        await expect
          .poll(
            async () =>
              (
                await runtime.request({
                  kind: 'managed-thread',
                  threadId: created.result.threadId!,
                })
              ).result,
          )
          .toMatchObject({ provider: selected, state: 'idle' });
        expect(
          (await runtime.request({ kind: 'managed-threads', workspaceRoot })).result.data,
        ).toHaveLength(1);
      } finally {
        await runtime.close();
      }
    });
  },
);

test.each(['codex', 'claude'] as const)(
  'missing diagnostic version metadata and additive initialization fields do not block %s control',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime: first, root, stateRoot, workspaceRoot, control }) => {
      // the runtime connects as it starts, so the CLI reports its metadata from its first answer
      await first.close();
      if (provider === 'claude')
        await control({ omitVersion: true, futureMetadata: { label: 'compatible extension' } });
      else
        await writeFixtureControl(root, 'control.json', {
          omitVersion: true,
          futureMetadata: { label: 'compatible extension' },
        });
      const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
      try {
        const created = await runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: runtime.runtimeEpoch,
            command: { kind: 'thread-create', provider, workspaceRoot, name: 'version-metadata' },
          },
        });
        await expect
          .poll(
            async () =>
              (
                await runtime.request({
                  kind: 'managed-thread',
                  threadId: created.result.threadId!,
                })
              ).result,
          )
          .toMatchObject({ state: 'idle' });
        expect((await runtime.request({ kind: 'status' })).result.providers).toEqual(
          expect.arrayContaining([{ provider, state: 'ready', version: null }]),
        );
      } finally {
        await runtime.close();
      }
    });
  },
);
