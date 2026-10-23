import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  callCodexTool,
  withAgentBridge,
  withCollaboration,
  writeFixtureControl,
} from '../../scripts/test-support/index.js';

const nativeResult = (reply: Awaited<ReturnType<typeof callCodexTool>>) => {
  const result = z
    .object({
      success: z.boolean(),
      contentItems: z.array(z.object({ type: z.literal('inputText'), text: z.string() })),
    })
    .parse(reply.result);
  return {
    success: result.success,
    payload: z.record(z.string(), z.json()).parse(JSON.parse(result.contentItems[0]!.text)),
  };
};

test('Codex tools derive stable identity and reject forged, cross-task and stale-turn inputs', async () =>
  withCollaboration(async (fixture) => {
    const first = nativeResult(await callCodexTool(fixture, 'hq_identity', {}));
    expect(first).toMatchObject({ success: true });
    expect(first.payload.identity).toMatchObject({
      agentId: fixture.agentIds[0],
      provider: 'codex',
      selectedTask: { id: fixture.taskId },
    });
    const calls = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)));
    const start = calls.find((call) => call.method === 'thread/start');
    expect(start?.params).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'hq_identity' }),
      ]),
    });
    for (const args of [{ agentId: fixture.agentIds[1] }, { taskId: randomUUID() }]) {
      const denied = nativeResult(await callCodexTool(fixture, 'hq_identity', args));
      expect(denied.success).toBe(false);
    }
    const stale = nativeResult(
      await callCodexTool(fixture, 'hq_identity', {}, { toolTurnId: 'another-turn' }),
    );
    expect(stale.success).toBe(false);
    const status = await fixture.native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing epoch');
    await writeFixtureControl(fixture.native.root, 'control.json', {});
    const compact = await fixture.native.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-compact', threadId: fixture.agentIds[0]! },
      },
    });
    if (compact.kind !== 'action') throw new Error('Missing compaction');
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({
          kind: 'receipt',
          actionId: compact.result.id,
        });
        return receipt.kind === 'receipt' ? receipt.result?.completion : null;
      })
      .toBe('completed');
    expect(
      nativeResult(await callCodexTool(fixture, 'hq_identity', {})).payload.identity,
    ).toMatchObject({ agentId: fixture.agentIds[0], selectedTask: { id: fixture.taskId } });
  }));

test('verifiable native children share the owning HQ identity and mismatched lineage is denied', async () =>
  withCollaboration(async (fixture) => {
    const inherited = nativeResult(
      await callCodexTool(fixture, 'hq_identity', {}, { toolChild: true }),
    );
    expect(inherited.success).toBe(true);
    expect(inherited.payload.identity).toMatchObject({
      agentId: fixture.agentIds[0],
      nativeId: 'native-1',
    });
    const wrongRoot = await callCodexTool(
      fixture,
      'hq_identity',
      {},
      { toolChild: true, toolRoot: '/outside' },
    );
    expect(wrongRoot.error).toBeDefined();
    const cycle = await callCodexTool(
      fixture,
      'hq_identity',
      {},
      { toolChild: true, toolParent: 'child-native-1' },
    );
    expect(cycle.error).toBeDefined();
  }));

test('managed spawn preserves parent linkage, narrowed permissions and exact replay across vendors', async () =>
  withCollaboration(async (fixture) => {
    await fixture.call({
      kind: 'agent-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: fixture.agentIds[0]!,
      expectedRevision: 1,
      permissions: { ...fixture.permissions, effects: ['read'], canManagePeerSubscriptions: false },
    });
    const id = randomUUID();
    const args = {
      id,
      taskId: fixture.taskId,
      provider: 'claude',
      workspaceRoot: fixture.native.workspaceRoot,
      purpose: 'Review the parser',
    };
    const spawned = nativeResult(await callCodexTool(fixture, 'hq_agent_spawn', args));
    expect(spawned).toMatchObject({ success: true });
    const childId = z.uuid().parse(spawned.payload.agentId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: id });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await withAgentBridge(
      { ...fixture, agentIds: [fixture.agentIds[0]!, childId] },
      async (bridge) => {
        const identity = await bridge.call('hq_identity', {});
        expect(identity.isError).toBe(false);
        expect(JSON.parse(identity.content[0]!.text)).toMatchObject({
          identity: {
            agentId: childId,
            provider: 'claude',
            purpose: args.purpose,
            membership: { parentAgentId: fixture.agentIds[0] },
          },
        });
      },
    );
    const membership = await fixture.call({
      kind: 'agent-read',
      taskId: fixture.taskId,
      agentId: childId,
    });
    expect(membership).toMatchObject({
      kind: 'agent',
      agent: {
        agentId: childId,
        parentAgentId: fixture.agentIds[0],
        provider: 'claude',
        permissions: { effects: ['read'], canManagePeerSubscriptions: false },
      },
    });
    const replay = nativeResult(await callCodexTool(fixture, 'hq_agent_spawn', args));
    expect(replay.success).toBe(true);
    expect(replay.payload.agentId).toBe(childId);
    const changed = nativeResult(
      await callCodexTool(fixture, 'hq_agent_spawn', { ...args, purpose: 'Different operation' }),
    );
    expect(changed.success).toBe(false);
    expect(await fixture.call({ kind: 'task-read', taskId: fixture.taskId })).toMatchObject({
      kind: 'task',
      task: { spawnCount: 1 },
    });
    const starts = (await readFile(join(fixture.native.root, 'claude-starts.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(starts).toHaveLength(2);
  }));

// The native action acknowledgement deadline is 30 seconds; this verifies the actual uncertain path.
test(
  'uncertain child creation retains capacity and never sends the same spawn twice',
  { timeout: 40_000 },
  async () =>
    withCollaboration(async (fixture) => {
      const args = {
        id: randomUUID(),
        taskId: fixture.taskId,
        provider: 'codex',
        workspaceRoot: fixture.native.workspaceRoot,
        purpose: 'Uncertain child',
      };
      const first = nativeResult(
        await callCodexTool(fixture, 'hq_agent_spawn', args, { suppressStartAck: true }),
      );
      expect(first.success).toBe(true);
      await expect
        .poll(
          async () => {
            const receipt = await fixture.native.request({ kind: 'receipt', actionId: args.id });
            return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
          },
          { timeout: 35_000, interval: 64 },
        )
        .toBe('uncertain');
      const replay = nativeResult(await callCodexTool(fixture, 'hq_agent_spawn', args));
      expect(replay.success).toBe(true);
      expect(replay.payload.agentId).toBe(first.payload.agentId);
      expect(replay.payload.receipt).toMatchObject({ id: args.id, delivery: 'uncertain' });
      expect(await fixture.call({ kind: 'task-read', taskId: fixture.taskId })).toMatchObject({
        kind: 'task',
        task: { spawnCount: 1 },
      });
      const starts = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)))
        .filter((call) => call.method === 'thread/start');
      expect(starts).toHaveLength(2);
    }),
);
