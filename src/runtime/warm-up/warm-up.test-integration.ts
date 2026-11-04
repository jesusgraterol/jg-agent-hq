// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { claudeRecord, withClaudeRuntime } from '../../../scripts/test-support/index.js';

// the sessions Claude's history index holds for a folder, read beside the running runtime
const indexed = (stateRoot: string, workspaceRoot: string): string[] => {
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT native_id FROM agent_hq_claude_file WHERE workspace_root = ?')
      .all(workspaceRoot)
      .map((row) => z.object({ native_id: z.string() }).parse(row).native_id);
  } finally {
    database.close();
  }
};

test('the runtime connects Codex and indexes Claude history as it starts, before any request', async () => {
  await withClaudeRuntime(
    async ({ runtime: first, root, stateRoot, workspaceRoot, transcript }) => {
      await first.close();
      const nativeId = randomUUID();
      await writeFile(
        transcript(nativeId),
        `${JSON.stringify(claudeRecord(workspaceRoot, nativeId))}\n`,
      );
      const earlierCalls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).length;
      const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
      try {
        await expect
          .poll(async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).slice(earlierCalls))
          .toContain('"method":"initialize"');
        await expect.poll(() => indexed(stateRoot, workspaceRoot)).toStrictEqual([nativeId]);
        // the first request finds both providers ready
        expect((await runtime.request({ kind: 'status' })).result.providers).toStrictEqual([
          { provider: 'codex', state: 'ready', version: 'codex-cli/fixture' },
          { provider: 'claude', state: 'ready', version: '2.1.304' },
        ]);
      } finally {
        await runtime.close();
      }
    },
  );
});

test('closing the runtime stops a warm-up still waiting on a CLI that never answers', async () => {
  await withClaudeRuntime(async ({ runtime: first, root, stateRoot, workspaceRoot, control }) => {
    await first.close();
    const startedCalls = (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).length;
    await control({ holdInitialization: true });
    const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      await expect
        .poll(async () =>
          (await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).slice(startedCalls),
        )
        .toContain('"subtype":"initialize"');
      const { pid } = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(join(root, 'claude-pid.json'), 'utf8')));
      expect((await runtime.request({ kind: 'status' })).result.providers).toContainEqual({
        provider: 'claude',
        state: 'idle',
        version: null,
      });
      await runtime.close();
      // the read process that never answered stopped with the runtime
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await runtime.close();
    }
  });
});
