import type { DatabaseSync } from 'node:sqlite';

import type { IActionEnvelope } from '../../contracts/index.js';
import {
  AgentSpawnRecordSchema,
  type IAgentSpawnAdmission,
  type IAgentSpawnRead,
  type IAgentSpawnRecord,
} from '../../collaboration/identity/index.js';
import { collaborationConflict, collaborationForbidden } from '../../collaboration/grants/index.js';

import { readNativeAgent } from './identity.js';
import { effectivePermissions, requireActiveAgent, taskAccess } from './authority.js';
import type { ICollaborationContext } from './types.js';

/**
 * Rechecks the session and task before returning an exact spawn relationship.
 * @returns The retained relationship, or null when that action identity has never been used.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const readAgentSpawn = (
  database: DatabaseSync,
  query: IAgentSpawnRead,
  runtimeEpoch: string,
): IAgentSpawnRecord | null => {
  const native = readNativeAgent(database, query.binding, runtimeEpoch);
  taskAccess(database, { kind: 'agent', agentId: native.agentId }, query.taskId);
  const row = database
    .prepare(
      'SELECT action_id, task_id, parent_agent_id, child_agent_id, purpose, command_digest, created_at FROM hq_agent_spawn WHERE action_id = ?',
    )
    .get(query.actionId);
  if (!row) {
    if (database.prepare('SELECT 1 FROM hq_action WHERE id = ?').get(query.actionId))
      return collaborationConflict();
    return null;
  }
  const record = AgentSpawnRecordSchema.parse({
    actionId: row.action_id,
    taskId: row.task_id,
    parentAgentId: row.parent_agent_id,
    childAgentId: row.child_agent_id,
    purpose: row.purpose,
    commandDigest: row.command_digest,
    createdAt: row.created_at,
  });
  if (record.taskId !== query.taskId || record.parentAgentId !== native.agentId)
    return collaborationForbidden();
  if (record.commandDigest !== query.commandDigest) return collaborationConflict();
  return record;
};

/**
 * Resolves the parent before native admission; copied task or agent labels grant nothing.
 * @returns Current task authority inside the caller's native-action transaction.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const agentSpawnContext = (
  database: DatabaseSync,
  scope: IAgentSpawnAdmission,
  runtimeEpoch: string,
): ICollaborationContext => {
  const native = readNativeAgent(database, scope.binding, runtimeEpoch);
  return taskAccess(database, { kind: 'agent', agentId: native.agentId }, scope.taskId);
};

/**
 * Links the one native receipt to its exact requesting agent before the admission savepoint.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const recordAgentSpawn = (
  database: DatabaseSync,
  actionId: string,
  scope: IAgentSpawnAdmission,
  context: ICollaborationContext,
): void => {
  if (context.member === null) return collaborationForbidden();
  database
    .prepare(
      'INSERT INTO hq_agent_spawn (action_id, task_id, parent_agent_id, purpose, command_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      actionId,
      context.task.id,
      context.member.agentId,
      scope.purpose,
      scope.commandDigest,
      Date.now(),
    );
};

/**
 * Reserves cumulative task capacity and equal-or-narrower membership with native thread creation.
 * Uncertain native creation retains this reservation; a new identity never retries that effect.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const reserveAgentChild = (
  database: DatabaseSync,
  context: ICollaborationContext,
  action: IActionEnvelope,
  childAgentId: string,
  workspaceRoot: string,
): void => {
  const parent = requireActiveAgent(context);
  const permissions = effectivePermissions(parent, context.task);
  const command = action.command;
  if (
    command.kind !== 'thread-create' ||
    !permissions.canSpawn ||
    permissions.effects.length === 0 ||
    !permissions.providers.includes(command.provider) ||
    !permissions.workspaceRoots.includes(workspaceRoot)
  )
    return collaborationForbidden();
  const reserved = database
    .prepare(
      'UPDATE hq_collaboration_task SET spawn_count = spawn_count + 1 WHERE id = ? AND spawn_count < ?',
    )
    .run(context.task.id, context.task.policy.spawnLimit);
  if (reserved.changes !== 1) return collaborationConflict();
  database
    .prepare(
      `INSERT INTO hq_task_agent (task_id, agent_id, parent_agent_id, role, permissions, revision, state, is_revoked, created_at)
    VALUES (?, ?, ?, NULL, ?, 1, 'active', 0, ?)`,
    )
    .run(context.task.id, childAgentId, parent.agentId, JSON.stringify(permissions), Date.now());
  database
    .prepare('UPDATE hq_agent_spawn SET child_agent_id = ? WHERE action_id = ?')
    .run(childAgentId, action.id);
};
