import type { DatabaseSync } from 'node:sqlite';

import type {
  IAgentPermissions,
  ICollaborationActor,
  ICollaborationTask,
  ITaskAgent,
} from '../../contracts/collaboration/index.js';
import { collaborationForbidden, collaborationConflict } from '../../collaboration/grants/index.js';

import {
  TASK_COLUMNS,
  AGENT_COLUMNS,
  GRANT_COLUMNS,
  STREAM_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  REQUEST_COLUMNS,
} from './constants.js';
import {
  toTask,
  toTaskAgent,
  toGrant,
  toStream,
  toSubscription,
  toRequest,
} from './transformers.js';
import type { ICollaborationContext } from './types.js';

/**
 * Returns the current task; an unknown identity cannot be used as an alternate scope.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readTask = (database: DatabaseSync, taskId: string): ICollaborationTask => {
  const row = database
    .prepare(`SELECT ${TASK_COLUMNS} FROM hq_collaboration_task WHERE id = ?`)
    .get(taskId);
  if (!row) return collaborationForbidden();
  return toTask(row);
};

/**
 * Resolves membership and its actual provider/workspace through the managed-thread ledger.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readMember = (database: DatabaseSync, taskId: string, agentId: string): ITaskAgent => {
  const row = database
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM hq_task_agent a JOIN hq_thread t ON t.id = a.agent_id WHERE a.task_id = ? AND a.agent_id = ?`,
    )
    .get(taskId, agentId);
  if (!row) return collaborationForbidden();
  return toTaskAgent(row);
};

/**
 * Rechecks host ownership or non-revoked task membership for every metadata operation.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const taskAccess = (
  database: DatabaseSync,
  actor: ICollaborationActor,
  taskId: string,
): ICollaborationContext => {
  const task = readTask(database, taskId);
  if (actor.kind === 'host') {
    if (actor.operatorRef !== task.ownerOperatorRef) return collaborationForbidden();
    return { actor, task, member: null };
  }
  const member = readMember(database, taskId, actor.agentId);
  if (member.isRevoked) return collaborationForbidden();
  return { actor, task, member };
};

/**
 * Host-only changes never derive operator authority from a role, message or grant ID.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const requireHost = (context: ICollaborationContext): string => {
  if (context.actor.kind !== 'host' || context.actor.operatorRef !== context.task.ownerOperatorRef)
    return collaborationForbidden();
  return context.actor.operatorRef;
};

/** Computes the current intersection, so a narrower task policy immediately limits every member. */
export const effectivePermissions = (
  member: ITaskAgent,
  task: ICollaborationTask,
): IAgentPermissions => ({
  providers: member.permissions.providers.filter((provider) =>
    task.policy.providers.includes(provider),
  ),
  workspaceRoots: member.permissions.workspaceRoots.filter((root) =>
    task.policy.workspaceRoots.includes(root),
  ),
  effects: member.permissions.effects.filter((effect) => task.policy.effects.includes(effect)),
  canSpawn: member.permissions.canSpawn && task.policy.canSpawn,
  canManagePeerSubscriptions:
    member.permissions.canManagePeerSubscriptions && task.policy.canManagePeerSubscriptions,
  canExecuteRequests: member.permissions.canExecuteRequests && task.policy.canExecuteRequests,
});

/**
 * Requires a current agent admission while retaining historical reads for paused participants.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const requireActiveAgent = (context: ICollaborationContext): ITaskAgent => {
  if (!context.member || context.member.isRevoked) return collaborationForbidden();
  if (context.task.state !== 'active' || context.member.state !== 'active')
    return collaborationConflict();
  const permissions = effectivePermissions(context.member, context.task);
  if (
    !permissions.providers.includes(context.member.provider) ||
    !permissions.workspaceRoots.includes(context.member.workspaceRoot)
  )
    return collaborationForbidden();
  return context.member;
};

/**
 * Returns one grant only inside its owning task. Eligibility is checked separately at admission.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readGrant = (database: DatabaseSync, taskId: string, id: string) => {
  const row = database
    .prepare(`SELECT ${GRANT_COLUMNS} FROM hq_skill_grant WHERE task_id = ? AND id = ?`)
    .get(taskId, id);
  if (!row) return collaborationForbidden();
  return toGrant(row);
};

/**
 * Resolves a stream without permitting cross-task substitutions.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readStream = (database: DatabaseSync, taskId: string, id: string) => {
  const row = database
    .prepare(`SELECT ${STREAM_COLUMNS} FROM hq_stream WHERE task_id = ? AND id = ?`)
    .get(taskId, id);
  if (!row) return collaborationForbidden();
  return toStream(row);
};

/** Reads subscription state independently of assigned requests and delivery rows. */
export const readSubscription = (
  database: DatabaseSync,
  taskId: string,
  streamId: string,
  agentId: string,
) => {
  const row = database
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM hq_subscription WHERE task_id = ? AND stream_id = ? AND agent_id = ?`,
    )
    .get(taskId, streamId, agentId);
  return row ? toSubscription(row) : null;
};

/**
 * Resolves a request from its immutable originating message and current assignment.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readRequest = (database: DatabaseSync, taskId: string, id: string) => {
  const row = database
    .prepare(
      `SELECT ${REQUEST_COLUMNS} FROM hq_request r JOIN hq_message m ON m.id = r.id WHERE r.task_id = ? AND r.id = ?`,
    )
    .get(taskId, id);
  if (!row) return collaborationForbidden();
  return toRequest(row);
};
