// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import type { IActionCommand } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime, writeFixtureControl } from '../../../../scripts/test-support/index.js';

// the runtime epoch of each native observation the state root holds to recognize a repeated one
const readEventEpochs = (stateRoot: string): string[] => {
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT runtime_epoch FROM agent_hq_event ORDER BY sequence')
      .all()
      .map((row) => z.object({ runtime_epoch: z.string() }).parse(row).runtime_epoch);
  } finally {
    database.close();
  }
};

test('startup deletes the observations earlier runtimes recorded, and the new runtime still recognizes a repeated one', async () => {
  await withClaudeRuntime(async ({ root, stateRoot, workspaceRoot, runtime, request }) => {
    await runtime.close();
    // rows two earlier runtimes left
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      const insert = database.prepare(
        'INSERT INTO agent_hq_event (runtime_epoch, event_key, digest) VALUES (?, ?, ?)',
      );
      for (const epoch of [randomUUID(), randomUUID()])
        for (const key of ['a', 'b']) insert.run(epoch, key.repeat(64), 'c'.repeat(64));
    } finally {
      database.close();
    }
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect(readEventEpochs(stateRoot)).toStrictEqual([]);
      const status = await request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime status');
      const { runtimeEpoch } = status.result;
      const submit = async (command: IActionCommand) => {
        const response = await request({
          kind: 'action',
          action: { id: randomUUID(), runtimeEpoch, command },
        });
        if (response.kind !== 'action') throw new Error('Missing action receipt');
        return response.result;
      };
      const readThread = async (threadId: string) => {
        const response = await request({ kind: 'managed-thread', threadId });
        return response.kind === 'managed-thread' ? response.result : null;
      };
      const created = await submit({
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot,
        name: 'repeated-start',
      });
      await expect
        .poll(async () => (await readThread(created.threadId!))?.state, { timeout: 5_000 })
        .toBe('idle');
      await writeFixtureControl(root, 'control.json', { holdTurn: true });
      await submit({
        kind: 'message',
        threadId: created.threadId!,
        input: { kind: 'text', text: 'Keep working' },
      });
      await expect
        .poll(async () => (await readThread(created.threadId!))?.activeTurnId, { timeout: 5_000 })
        .not.toBeNull();
      const thread = (await readThread(created.threadId!))!;
      // the turn's start is this runtime's first observation
      expect(readEventEpochs(stateRoot)).toStrictEqual([runtimeEpoch]);
      // the same start again adds nothing, while a request resolution after it adds its row
      await writeFixtureControl(root, 'control.json', {
        holdTurn: true,
        emitOnce: true,
        emit: [
          {
            method: 'turn/started',
            params: {
              threadId: thread.nativeId,
              turn: { id: thread.activeTurnId, status: 'inProgress' },
            },
          },
          {
            method: 'serverRequest/resolved',
            params: { threadId: thread.nativeId, requestId: 'marker' },
          },
        ],
      });
      await request({ kind: 'usage', provider: 'codex' });
      await expect
        .poll(() => readEventEpochs(stateRoot), { timeout: 5_000 })
        .toStrictEqual([runtimeEpoch, runtimeEpoch]);
      expect(await readThread(thread.id)).toMatchObject({
        state: 'running',
        ownership: 'managed',
        activeTurnId: thread.activeTurnId,
      });
    } finally {
      await reopened.close();
    }
  });
});
