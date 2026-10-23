import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  RequestSpecificationSchema,
  type ICollaborationCommand,
  type ICollaborationResult,
  type IInvocation,
} from '../../contracts/collaboration/index.js';
import { collaborationConflict, collaborationForbidden } from '../../collaboration/grants/index.js';
import { DispatchContextSchema } from '../../collaboration/dispatch/index.js';

import {
  readRequest,
  readGrant,
  readMember,
  requireHost,
  requireActiveAgent,
} from './authority.js';
import { authorizeRecipient, ensureDelivery } from './requests.js';
import { insertMessage } from './messages.js';
import type { ICollaborationContext } from './types.js';

/**
 * Returns the one active assigned invocation, checking its exact current selected authority.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const readInvocation = (
  database: DatabaseSync,
  context: ICollaborationContext,
): IInvocation | null => {
  if (context.actor.kind !== 'agent') return collaborationForbidden();
  const row = database
    .prepare(
      'SELECT id, task_id, current_action_id FROM hq_request WHERE assignee_agent_id = ? AND current_action_id IS NOT NULL',
    )
    .get(context.actor.agentId);
  if (!row) return null;
  if (row.task_id !== context.task.id) return collaborationForbidden();
  const request = readRequest(database, context.task.id, z.uuid().parse(row.id));
  if (request.state !== 'claimed') return collaborationConflict();
  const action = database
    .prepare('SELECT collaboration_context, native_turn_id FROM hq_action WHERE id = ?')
    .get(z.uuid().parse(row.current_action_id));
  const selected = DispatchContextSchema.parse(
    JSON.parse(z.string().parse(action?.collaboration_context)),
  );
  authorizeRecipient(database, context, selected.specification, context.actor.agentId, true);
  if (JSON.stringify(request.specification) !== JSON.stringify(selected.specification))
    return collaborationConflict();
  const grant =
    selected.specification.grantId === null
      ? null
      : readGrant(database, context.task.id, selected.specification.grantId);
  const input =
    selected.inputMessageId === null
      ? null
      : database
          .prepare('SELECT id, author FROM hq_message WHERE task_id = ? AND id = ?')
          .get(context.task.id, selected.inputMessageId);
  return {
    taskId: context.task.id,
    agentId: context.actor.agentId,
    request,
    actionId: z.uuid().parse(row.current_action_id),
    nativeTurnId: z.string().nullable().parse(action?.native_turn_id),
    grant:
      grant === null
        ? null
        : { id: grant.id, revision: grant.revision, issuerOperatorRef: grant.issuerOperatorRef },
    input: input
      ? { messageId: z.uuid().parse(input.id), author: JSON.parse(z.string().parse(input.author)) }
      : null,
  };
};

type ICheckpointCommand = Extract<
  ICollaborationCommand,
  { kind: 'request-dispatch' | 'request-input' | 'request-resume' | 'request-authorize' }
>;

/**
 * Records explicit dispatch, scoped checkpoint input or host reauthorization without native calls.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const mutateCheckpoint = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: ICheckpointCommand,
): ICollaborationResult => {
  const request = readRequest(database, context.task.id, command.requestId);
  if (request.currentActionId !== null || ['resolved', 'canceled'].includes(request.state))
    return collaborationConflict();
  if (command.kind === 'request-dispatch') {
    requireHost(context);
    if (
      !['open', 'claimed'].includes(request.state) ||
      request.pendingActionId === null ||
      (request.assigneeAgentId === null && request.specification.targetAgentId === null)
    )
      return collaborationConflict();
    database
      .prepare(
        'UPDATE hq_request SET manual_dispatch_id = ?, dispatch_blocked_reason = NULL, updated_at = ? WHERE id = ?',
      )
      .run(command.id, Date.now(), request.id);
  } else {
    const assigneeId = request.assigneeAgentId ?? request.specification.targetAgentId;
    if (request.lastActionId !== command.expectedActionId || assigneeId === null)
      return collaborationConflict();
    if (command.kind === 'request-authorize') {
      requireHost(context);
      if (
        !['interrupted', 'waiting-input'].includes(request.state) &&
        !(request.dispatchCount === 0 && ['open', 'claimed'].includes(request.state))
      )
        return collaborationConflict();
      const parsed = RequestSpecificationSchema.safeParse({
        ...request.specification,
        grantId: command.grantId,
        grantRevision: command.grantRevision,
        plan: command.plan,
      });
      if (!parsed.success) return collaborationConflict();
      authorizeRecipient(database, context, parsed.data, assigneeId, false);
      database
        .prepare(
          'UPDATE hq_request SET specification = ?, grant_id = ?, grant_revision = ?, dispatch_blocked_reason = NULL, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify(parsed.data),
          command.grantId,
          command.grantRevision,
          Date.now(),
          request.id,
        );
    } else {
      if (command.kind === 'request-input') {
        if (context.actor.kind === 'agent') requireActiveAgent(context);
        if (request.state !== 'waiting-input') return collaborationConflict();
        if (
          context.actor.kind === 'agent' &&
          (request.requiredAuthority !== 'requester' ||
            request.requester.kind !== 'agent' ||
            request.requester.agentId !== context.actor.agentId)
        )
          return collaborationForbidden();
      } else {
        requireHost(context);
        const member = readMember(database, context.task.id, assigneeId);
        if (
          request.state !== 'interrupted' ||
          context.task.state !== 'active' ||
          context.task.lifecycleRevision !== command.expectedTaskRevision ||
          member.revision !== command.expectedAgentRevision ||
          member.isRevoked ||
          member.state === 'stopped' ||
          (request.pauseAgentRevision !== null && request.pauseAgentRevision !== member.revision)
        )
          return collaborationConflict();
        if (member.state === 'paused')
          database
            .prepare(
              "UPDATE hq_task_agent SET state = 'active', revision = revision + 1 WHERE task_id = ? AND agent_id = ?",
            )
            .run(context.task.id, member.agentId);
      }
      authorizeRecipient(database, context, request.specification, assigneeId, true);
      const input = insertMessage(database, context.task.id, context.actor, {
        id: command.id,
        streamId: request.streamId,
        messageKind: 'reply',
        summary:
          command.kind === 'request-input'
            ? 'Requested checkpoint input'
            : 'Explicit request resumption',
        body: command.body,
        references: [],
        replyToMessageId: request.id,
      });
      ensureDelivery(database, context.task.id, input.id, input.sequence, assigneeId);
      database
        .prepare(
          `UPDATE hq_request SET state = 'claimed', pending_action_id = ?, pending_input_message_id = ?, manual_dispatch_id = ?, required_authority = NULL, pause_agent_revision = NULL, dispatch_blocked_reason = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          command.id,
          input.id,
          context.actor.kind === 'host' ? command.id : null,
          Date.now(),
          request.id,
        );
    }
  }
  return { kind: 'request', request: readRequest(database, context.task.id, request.id) };
};
