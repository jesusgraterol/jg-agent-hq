import type { DatabaseSync } from 'node:sqlite';

import type {
  ICollaborationResult,
  IRequestSpecification,
} from '../../contracts/collaboration/index.js';
import {
  assertRequestAuthority,
  collaborationConflict,
  collaborationForbidden,
} from '../../collaboration/grants/index.js';

import {
  effectivePermissions,
  readGrant,
  readMember,
  readRequest,
  readSubscription,
  requireActiveAgent,
} from './authority.js';
import type { ICollaborationContext, IRequestMutation } from './types.js';

/**
 * Rechecks the selected recipient's current membership, policy and grant.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const authorizeRecipient = (
  database: DatabaseSync,
  context: ICollaborationContext,
  specification: IRequestSpecification,
  agentId: string,
  requireActive: boolean,
): void => {
  const member = readMember(database, context.task.id, agentId);
  if (member.isRevoked) return collaborationForbidden();
  if (requireActive) requireActiveAgent({ ...context, member });
  const permissions = effectivePermissions(member, context.task);
  if (
    !permissions.providers.includes(member.provider) ||
    !permissions.workspaceRoots.includes(member.workspaceRoot)
  )
    return collaborationForbidden();
  const grant =
    specification.grantId === null
      ? null
      : readGrant(database, context.task.id, specification.grantId);
  assertRequestAuthority(specification, context.task.id, member.agentId, permissions, grant);
};

/**
 * Inserts an idempotent metadata delivery without claiming native acceptance.
 */
export const ensureDelivery = (
  database: DatabaseSync,
  taskId: string,
  messageId: string,
  sequence: number,
  agentId: string,
): void => {
  database
    .prepare(
      `INSERT INTO hq_delivery (task_id, message_id, message_sequence, recipient_agent_id)
    VALUES (?, ?, ?, ?) ON CONFLICT(message_id, recipient_agent_id) DO NOTHING`,
    )
    .run(taskId, messageId, sequence, agentId);
};

/**
 * Claims or explicitly finishes non-dispatched work inside the metadata transaction.
 * @returns The current request, independently of message reads or acknowledgements.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const mutateRequest = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: IRequestMutation,
): ICollaborationResult => {
  const request = readRequest(database, context.task.id, command.requestId);
  if (
    request.state === 'resolved' ||
    request.state === 'canceled' ||
    (request.currentActionId !== null && command.kind !== 'request-cancel')
  )
    return collaborationConflict();
  const actorId = context.actor.kind === 'agent' ? context.actor.agentId : null;
  const isRequester =
    context.actor.kind === 'host' ||
    (request.requester.kind === 'agent' && request.requester.agentId === actorId);
  const isAssignee = actorId !== null && request.assigneeAgentId === actorId;
  const now = Date.now();
  switch (command.kind) {
    case 'request-claim': {
      if (actorId === null) return collaborationForbidden();
      requireActiveAgent(context);
      if (request.state !== 'open' || request.assigneeAgentId !== null)
        return collaborationConflict();
      if (
        request.specification.targetAgentId !== null &&
        request.specification.targetAgentId !== actorId
      )
        return collaborationForbidden();
      if (
        request.specification.claimable &&
        !readSubscription(database, request.taskId, request.streamId, actorId)?.isActive
      )
        return collaborationForbidden();
      authorizeRecipient(database, context, request.specification, actorId, true);
      database
        .prepare(
          "UPDATE hq_request SET assignee_agent_id = ?, state = 'claimed', pending_action_id = coalesce(pending_action_id, id), updated_at = ? WHERE id = ?",
        )
        .run(actorId, now, request.id);
      ensureDelivery(database, request.taskId, request.id, request.sequence, actorId);
      break;
    }
    case 'request-resolve':
      if (context.actor.kind !== 'host' && !isAssignee) return collaborationForbidden();
      if (
        request.state !== 'claimed' ||
        request.assigneeAgentId === null ||
        request.dispatchCount !== 0
      )
        return collaborationConflict();
      // A revoked grant prevents new execution, but must not conceal already obtained evidence.
      database
        .prepare(
          "UPDATE hq_request SET state = 'resolved', outcome = ?, result_references = ?, pending_action_id = NULL, manual_dispatch_id = NULL, updated_at = ? WHERE id = ?",
        )
        .run(command.outcome, JSON.stringify(command.references), now, request.id);
      break;
    case 'request-cancel':
      if (!isRequester && !isAssignee) return collaborationForbidden();
      database
        .prepare(
          "UPDATE hq_request SET state = 'canceled', pending_action_id = NULL, manual_dispatch_id = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, request.id);
      break;
    case 'request-reassign': {
      if (!isRequester) return collaborationForbidden();
      if (request.assigneeAgentId !== command.expectedAssigneeAgentId)
        return collaborationConflict();
      const specification = {
        ...request.specification,
        targetAgentId: command.targetAgentId,
        claimable: false,
      };
      authorizeRecipient(database, context, specification, command.targetAgentId, false);
      database
        .prepare(
          "UPDATE hq_request SET specification = ?, target_agent_id = ?, is_claimable = 0, assignee_agent_id = NULL, state = 'open', pending_action_id = ?, pending_input_message_id = NULL, manual_dispatch_id = NULL, required_authority = NULL, pause_agent_revision = NULL, dispatch_blocked_reason = NULL, failure_reason = NULL, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(specification), command.targetAgentId, command.id, now, request.id);
      ensureDelivery(database, request.taskId, request.id, request.sequence, command.targetAgentId);
      break;
    }
  }
  return { kind: 'request', request: readRequest(database, request.taskId, request.id) };
};
