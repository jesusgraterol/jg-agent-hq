import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { IAgentHq } from 'jg-agent-hq';
import type {
  IAgentPermissions,
  ICollaborationActor,
  ICollaborationResponse,
  IHqRequestInput,
  ITaskPolicy,
} from 'jg-agent-hq/contracts';
import { expect } from 'vitest';

import { withClaudeRuntime, type IClaudeFixture } from './claude-runtime.js';

// public command inputs keep defaults optional at the real runtime boundary
type ICommand = Extract<IHqRequestInput, { kind: 'collaboration' }>['command'];
export type ICollaborationFixture = {
  native: IClaudeFixture;
  taskId: string;
  streamId: string;
  agentIds: string[];
  host: ICollaborationActor;
  permissions: IAgentPermissions;
  policy: ITaskPolicy;
  call(
    command: ICommand,
    actor?: ICollaborationActor,
    runtime?: IAgentHq,
  ): Promise<ICollaborationResponse>;
  seedAgents(count: number): Promise<string[]>;
};

/** Runs real public collaboration, worker and IPC flows against isolated external native fixtures. */
export const withCollaboration = async (
  run: (fixture: ICollaborationFixture) => Promise<void>,
): Promise<void> =>
  withClaudeRuntime(async (native) => {
    const status = await native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime status');
    const agentIds: string[] = [];
    for (const provider of ['codex', 'claude'] as const) {
      const response = await native.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider,
            workspaceRoot: native.workspaceRoot,
            name: `collaboration-${provider}`,
          },
        },
      });
      if (response.kind !== 'action' || response.result.threadId === null)
        throw new Error('Missing managed thread');
      agentIds.push(response.result.threadId);
      // cold native processes use the runtime's 30-second acknowledgement budget
      await expect
        .poll(
          async () => {
            const receipt = await native.request({ kind: 'receipt', actionId: response.result.id });
            return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
          },
          { timeout: 30_000 },
        )
        .toBe('acknowledged');
    }
    const host: ICollaborationActor = { kind: 'host', operatorRef: 'fixture-owner' };
    const permissions: IAgentPermissions = {
      providers: ['codex', 'claude'],
      workspaceRoots: [native.workspaceRoot],
      effects: ['read', 'planning-write', 'workspace-write', 'commit', 'push', 'pause', 'resume'],
      canSpawn: true,
      canManagePeerSubscriptions: true,
      canExecuteRequests: true,
    };
    const policy: ITaskPolicy = {
      ...permissions,
      automaticDispatch: false,
      concurrencyLimit: 2,
      spawnLimit: 8,
      automaticTurnLimit: 32,
    };
    const call: ICollaborationFixture['call'] = async (
      command,
      actor = host,
      runtime = native.runtime,
    ) => {
      const response = await runtime.request({ kind: 'collaboration', actor, command });
      if (response.kind !== 'collaboration') throw new Error('Missing collaboration response');
      return response.result;
    };
    const taskId = randomUUID();
    await call({
      kind: 'task-create',
      id: taskId,
      workspaceRoot: native.workspaceRoot,
      title: 'Cross-provider work',
      policy,
      plan: null,
    });
    const add = async (id: string) =>
      call({
        kind: 'agent-add',
        id: randomUUID(),
        taskId,
        agentId: id,
        parentAgentId: null,
        role: 'developer',
        permissions,
      });
    for (const agentId of agentIds) await add(agentId);
    const streamId = randomUUID();
    await call({
      kind: 'stream-create',
      id: streamId,
      taskId,
      title: 'Implementation',
      purpose: 'Small indexed coordination records',
    });
    const seedAgents = async (count: number): Promise<string[]> => {
      const ids = Array.from({ length: count }, () => randomUUID());
      // Model inactive managed sessions at the native boundary without starting hundreds of processes.
      await native.runtime.withStorageMaintenance(async ({ databasePath }) => {
        const database = new DatabaseSync(databasePath);
        try {
          database.exec('PRAGMA foreign_keys = ON');
          const insert =
            database.prepare(`INSERT INTO hq_thread (id, provider, native_id, name, workspace_root, ownership, state, registration_action_id, created_at, updated_at)
          SELECT ?, provider, ?, ?, workspace_root, 'managed', 'inactive', registration_action_id, created_at, updated_at FROM hq_thread WHERE id = ?`);
          for (const id of ids) insert.run(id, `fixture-${id}`, `fixture-${id}`, agentIds[0]!);
        } finally {
          database.close();
        }
      });
      for (const id of ids) await add(id);
      return ids;
    };
    await run({ native, taskId, streamId, agentIds, host, permissions, policy, call, seedAgents });
  });
