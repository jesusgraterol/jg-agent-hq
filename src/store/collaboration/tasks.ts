import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type {
  ICollaborationActor,
  ICollaborationCommand,
  ICollaborationResult,
  ICollaborationTask,
  IAgentPermissions,
} from '../../contracts/collaboration/index.js';
import {
  assertPermissionsSubset,
  assertScopesAllowed,
  collaborationConflict,
  collaborationForbidden,
  validateScopePath,
} from '../../collaboration/grants/index.js';

import { readTask, readMember, readGrant, requireHost, effectivePermissions } from './authority.js';
import type { ICollaborationContext, ITaskMutation } from './types.js';

const json = (input: unknown): string => JSON.stringify(input);

const validateTaskWorkspace = (workspaceRoot: string, permissions: IAgentPermissions): void => {
  if (!permissions.workspaceRoots.includes(workspaceRoot)) collaborationForbidden();
};

/**
 * Creates one host-owned scope without creating native agents or execution authority.
 * @returns The current task metadata.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const createTask = (
  database: DatabaseSync,
  actor: ICollaborationActor,
  command: Extract<ICollaborationCommand, { kind: 'task-create' }>,
): ICollaborationResult => {
  if (actor.kind !== 'host') return collaborationForbidden();
  validateTaskWorkspace(command.workspaceRoot, command.policy);
  database
    .prepare(
      `INSERT INTO hq_collaboration_task (id, workspace_root, owner_operator_ref, title, plan, policy, policy_revision, state, lifecycle_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 1, ?)`,
    )
    .run(
      command.id,
      command.workspaceRoot,
      actor.operatorRef,
      command.title,
      command.plan === null ? null : json(command.plan),
      json(command.policy),
      Date.now(),
    );
  return { kind: 'task', task: readTask(database, command.id) };
};

/**
 * Checks the actual managed identity and the task/parent capability ceiling before membership writes.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
const validateMemberPermissions = (
  database: DatabaseSync,
  task: ICollaborationTask,
  agentId: string,
  parentAgentId: string | null,
  permissions: IAgentPermissions,
): void => {
  assertPermissionsSubset(permissions, task.policy);
  const managed = database
    .prepare('SELECT provider, workspace_root FROM hq_thread WHERE id = ?')
    .get(agentId);
  if (!managed) return collaborationForbidden();
  const identity = z.object({ provider: z.string(), workspace_root: z.string() }).parse(managed);
  if (
    !permissions.providers.includes(identity.provider) ||
    !permissions.workspaceRoots.includes(identity.workspace_root)
  )
    return collaborationForbidden();
  if (parentAgentId !== null) {
    if (parentAgentId === agentId) return collaborationForbidden();
    const parent = readMember(database, task.id, parentAgentId);
    if (parent.isRevoked) return collaborationForbidden();
    assertPermissionsSubset(permissions, effectivePermissions(parent, task));
  }
};

/**
 * Applies host-only task, membership and skill-grant changes inside the caller's transaction.
 * @returns The exact resulting metadata, independently of native dispatch.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const mutateTask = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: ITaskMutation,
): ICollaborationResult => {
  const operatorRef = requireHost(context);
  const { task } = context;
  switch (command.kind) {
    case 'task-policy-set':
      if (command.expectedRevision !== task.policyRevision) return collaborationConflict();
      validateTaskWorkspace(task.workspaceRoot, command.policy);
      database
        .prepare(
          'UPDATE hq_collaboration_task SET policy = ?, policy_revision = policy_revision + 1 WHERE id = ?',
        )
        .run(json(command.policy), task.id);
      return { kind: 'task', task: readTask(database, task.id) };
    case 'task-plan-set':
      if (command.expectedRevision !== task.policyRevision) return collaborationConflict();
      database
        .prepare(
          'UPDATE hq_collaboration_task SET plan = ?, policy_revision = policy_revision + 1 WHERE id = ?',
        )
        .run(command.plan === null ? null : json(command.plan), task.id);
      return { kind: 'task', task: readTask(database, task.id) };
    case 'task-state-set':
      if (command.expectedRevision !== task.lifecycleRevision || command.state === task.state)
        return collaborationConflict();
      database
        .prepare(
          'UPDATE hq_collaboration_task SET state = ?, lifecycle_revision = lifecycle_revision + 1 WHERE id = ?',
        )
        .run(command.state, task.id);
      return { kind: 'task', task: readTask(database, task.id) };
    case 'agent-add': {
      validateMemberPermissions(
        database,
        task,
        command.agentId,
        command.parentAgentId,
        command.permissions,
      );
      const previous = database
        .prepare(
          'SELECT revision, is_revoked FROM hq_task_agent WHERE task_id = ? AND agent_id = ?',
        )
        .get(task.id, command.agentId);
      if (previous) {
        const saved = z
          .object({ revision: z.number().int(), is_revoked: z.number().int() })
          .parse(previous);
        if (saved.is_revoked !== 1 || command.expectedRevision !== saved.revision)
          return collaborationConflict();
        database
          .prepare(
            "UPDATE hq_task_agent SET parent_agent_id = ?, role = ?, permissions = ?, revision = revision + 1, state = 'active', is_revoked = 0 WHERE task_id = ? AND agent_id = ?",
          )
          .run(
            command.parentAgentId,
            command.role,
            json(command.permissions),
            task.id,
            command.agentId,
          );
      } else {
        if (command.expectedRevision !== undefined) return collaborationConflict();
        database
          .prepare(
            "INSERT INTO hq_task_agent (task_id, agent_id, parent_agent_id, role, permissions, revision, state, is_revoked, created_at) VALUES (?, ?, ?, ?, ?, 1, 'active', 0, ?)",
          )
          .run(
            task.id,
            command.agentId,
            command.parentAgentId,
            command.role,
            json(command.permissions),
            Date.now(),
          );
      }
      return { kind: 'agent', agent: readMember(database, task.id, command.agentId) };
    }
    case 'agent-policy-set': {
      const member = readMember(database, task.id, command.agentId);
      if (member.isRevoked || member.revision !== command.expectedRevision)
        return collaborationConflict();
      validateMemberPermissions(
        database,
        task,
        member.agentId,
        member.parentAgentId,
        command.permissions,
      );
      database
        .prepare(
          'UPDATE hq_task_agent SET permissions = ?, revision = revision + 1 WHERE task_id = ? AND agent_id = ?',
        )
        .run(json(command.permissions), task.id, member.agentId);
      return { kind: 'agent', agent: readMember(database, task.id, member.agentId) };
    }
    case 'agent-state-set': {
      const member = readMember(database, task.id, command.agentId);
      if (
        member.isRevoked ||
        member.revision !== command.expectedRevision ||
        member.state === command.state
      )
        return collaborationConflict();
      database
        .prepare(
          'UPDATE hq_task_agent SET state = ?, revision = revision + 1 WHERE task_id = ? AND agent_id = ?',
        )
        .run(command.state, task.id, member.agentId);
      return { kind: 'agent', agent: readMember(database, task.id, member.agentId) };
    }
    case 'agent-revoke': {
      const member = readMember(database, task.id, command.agentId);
      if (member.isRevoked || member.revision !== command.expectedRevision)
        return collaborationConflict();
      database
        .prepare(
          'UPDATE hq_task_agent SET is_revoked = 1, revision = revision + 1 WHERE task_id = ? AND agent_id = ?',
        )
        .run(task.id, member.agentId);
      return { kind: 'agent', agent: readMember(database, task.id, member.agentId) };
    }
    case 'grant-issue': {
      if (command.effects.some((effect) => !task.policy.effects.includes(effect)))
        return collaborationForbidden();
      assertScopesAllowed(
        command.scopes,
        task.policy.workspaceRoots.map((workspaceRoot) => ({ workspaceRoot, pathPrefixes: [''] })),
      );
      for (const scope of command.scopes)
        for (const path of scope.pathPrefixes) validateScopePath(path);
      if (command.eligibleAgentIds !== null) {
        const eligible = new Set(command.eligibleAgentIds);
        const rows = database
          .prepare(
            `SELECT agent_id FROM hq_task_agent
          WHERE task_id = ? AND is_revoked = 0 AND agent_id IN (SELECT value FROM json_each(?))`,
          )
          .all(task.id, json([...eligible]));
        if (rows.length !== eligible.size) return collaborationForbidden();
      }
      database
        .prepare(
          `INSERT INTO hq_skill_grant (id, task_id, issuer_operator_ref, revision, eligible_agent_ids, skills, effects, scopes, plan, revoked_at, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          command.id,
          task.id,
          operatorRef,
          command.eligibleAgentIds === null ? null : json(command.eligibleAgentIds),
          json(command.skills),
          json(command.effects),
          json(command.scopes),
          command.plan === null ? null : json(command.plan),
          Date.now(),
        );
      return { kind: 'grant', grant: readGrant(database, task.id, command.id) };
    }
    case 'grant-revoke': {
      const grant = readGrant(database, task.id, command.grantId);
      if (grant.revision !== command.expectedRevision || grant.revokedAt !== null)
        return collaborationConflict();
      database
        .prepare(
          'UPDATE hq_skill_grant SET revoked_at = ?, revision = revision + 1 WHERE task_id = ? AND id = ?',
        )
        .run(Date.now(), task.id, grant.id);
      return { kind: 'grant', grant: readGrant(database, task.id, grant.id) };
    }
  }
};
