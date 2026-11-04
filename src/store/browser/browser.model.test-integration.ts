// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import type { IBrowserAction } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { withClaudeRuntime, type IClaudeFixture } from '../../../scripts/test-support/index.js';

// a native effect for the host's dispatcher, which these tests never submit to HQ
const browserAction = async (fixture: IClaudeFixture): Promise<IBrowserAction> => {
  const status = await fixture.runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  return {
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command: {
      kind: 'native',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'browser-columns',
        },
      },
    },
  };
};

// the receipt columns the ledger keeps for a browser action, as a plain object
const storedReceipt = (stateRoot: string, id: string): unknown => {
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    const row = database
      .prepare(
        'SELECT runtime_epoch, kind, state, native_action_id, created_at, updated_at FROM agent_hq_browser_action WHERE id = ?',
      )
      .get(id);
    return row && { ...row };
  } finally {
    database.close();
  }
};

test('a browser receipt keeps its state, epoch and native action in columns as the host settles it', async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await browserAction(fixture);
    let submitted: unknown;
    const receipt = await fixture.runtime.performBrowserAction(action, 'operator', async () => {
      submitted = storedReceipt(fixture.stateRoot, action.id);
    });
    expect(submitted).toStrictEqual({
      runtime_epoch: action.runtimeEpoch,
      kind: 'native',
      state: 'submitted',
      native_action_id: receipt.nativeActionId,
      created_at: receipt.createdAt,
      updated_at: receipt.createdAt,
    });
    expect(storedReceipt(fixture.stateRoot, action.id)).toStrictEqual({
      runtime_epoch: action.runtimeEpoch,
      kind: 'native',
      state: 'acknowledged',
      native_action_id: receipt.nativeActionId,
      created_at: receipt.createdAt,
      updated_at: receipt.updatedAt,
    });
    expect(receipt).toMatchObject({
      id: action.id,
      runtimeEpoch: action.runtimeEpoch,
      kind: 'native',
      state: 'acknowledged',
      native: null,
    });
    // a failed effect settles uncertain, and its receipt reads back from the same columns
    const failing = await browserAction(fixture);
    await expect(
      fixture.runtime.performBrowserAction(failing, 'operator', async () => {
        throw new Error('effect outcome unknown');
      }),
    ).rejects.toThrow('effect outcome unknown');
    expect(storedReceipt(fixture.stateRoot, failing.id)).toMatchObject({ state: 'uncertain' });
    expect(await fixture.runtime.readBrowserAction(failing.id, 'operator')).toMatchObject({
      state: 'uncertain',
      runtimeEpoch: failing.runtimeEpoch,
    });
  });
});

test("another runtime quarantines a submitted receipt by its epoch column and keeps the receipt's epoch and native action", async () => {
  await withClaudeRuntime(async (fixture) => {
    const action = await browserAction(fixture);
    const receipt = await fixture.runtime.performBrowserAction(action, 'operator', async () => {});
    await fixture.runtime.close();
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database
        .prepare("UPDATE agent_hq_browser_action SET state = 'submitted' WHERE id = ?")
        .run(action.id);
      // a native action ID names exactly one browser receipt
      expect(() =>
        database
          .prepare(
            "INSERT INTO agent_hq_browser_action (id, operator_id, digest, runtime_epoch, kind, state, native_action_id, created_at, updated_at) VALUES (?, 'operator', ?, ?, 'native', 'submitted', ?, 0, 0)",
          )
          .run(randomUUID(), 'a'.repeat(64), action.runtimeEpoch, receipt.nativeActionId),
      ).toThrow('UNIQUE constraint failed: agent_hq_browser_action.native_action_id');
    } finally {
      database.close();
    }
    const next = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect(await next.readBrowserAction(action.id, 'operator')).toMatchObject({
        state: 'uncertain',
        runtimeEpoch: action.runtimeEpoch,
        nativeActionId: receipt.nativeActionId,
      });
      expect(storedReceipt(fixture.stateRoot, action.id)).toMatchObject({
        runtime_epoch: action.runtimeEpoch,
        state: 'uncertain',
        native_action_id: receipt.nativeActionId,
      });
    } finally {
      await next.close();
    }
  });
});
