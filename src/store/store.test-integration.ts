// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import type { IActionCommand } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { withClaudeRuntime } from '../../scripts/test-support/index.js';

/*
 * Each request below runs one model operation in the store worker through the store's typed call:
 * reads of the control ledger, an admission that writes it, and the errors the worker sends back.
 */
test('store calls read and write the ledger in the worker, and return its coded errors and defects', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime status');
    const action = (command: IActionCommand, runtimeEpoch = status.result.runtimeEpoch) => ({
      kind: 'action' as const,
      action: { id: randomUUID(), runtimeEpoch, command },
    });
    const create = (name: string) =>
      action({ kind: 'thread-create', provider: 'codex', workspaceRoot, name });
    // reads
    expect(await runtime.request({ kind: 'managed-thread', threadId: randomUUID() })).toStrictEqual(
      { kind: 'managed-thread', result: null },
    );
    expect(
      await runtime.request({ kind: 'suggest-thread-name', topic: 'Store calls' }),
    ).toStrictEqual({ kind: 'suggest-thread-name', result: { name: 'store-calls' } });
    // a write, read back by a later call
    const created = await runtime.request(create('store-calls'));
    if (created.kind !== 'action') throw new Error('Missing action receipt');
    expect(created.result).toMatchObject({ kind: 'thread-create', delivery: 'submitted' });
    expect(
      await runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }),
    ).toMatchObject({ kind: 'managed-thread', result: { name: 'store-calls' } });
    expect(
      await runtime.request({ kind: 'suggest-thread-name', topic: 'Store calls' }),
    ).toStrictEqual({ kind: 'suggest-thread-name', result: { name: 'store-calls-2' } });
    // a coded error a model throws, such as admission's refusal of another runtime's action, keeps its code
    await expectToRejectCode(
      runtime.request(
        action(
          { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'stale' },
          randomUUID(),
        ),
      ),
      'JG_AGENT_HQ_ACTION_CONFLICT',
      'The HQ action conflicts with its recorded state',
    );
    // a defect, such as a SQLite error, fails the call as a store failure carrying its cause
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { timeout: 5000 });
    try {
      database.exec(
        "CREATE TRIGGER app_injected_defect BEFORE INSERT ON agent_hq_thread BEGIN SELECT RAISE(ABORT, 'injected store defect'); END",
      );
    } finally {
      database.close();
    }
    const failing = create('store-defect');
    try {
      await expectToRejectCode(
        runtime.request(failing),
        'JG_AGENT_HQ_STORE_FAILED',
        'The HQ store failed: injected store defect',
      );
    } finally {
      const cleanup = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { timeout: 5000 });
      try {
        cleanup.exec('DROP TRIGGER app_injected_defect');
      } finally {
        cleanup.close();
      }
    }
    // the failed call left nothing behind and the worker keeps serving calls
    expect(await runtime.request({ kind: 'receipt', actionId: failing.action.id })).toStrictEqual({
      kind: 'receipt',
      result: null,
    });
    expect(await runtime.request({ kind: 'status' })).toMatchObject({
      result: { store: 'ready' },
    });
  });
});
