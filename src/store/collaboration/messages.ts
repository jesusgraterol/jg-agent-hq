import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type {
  ICollaborationCommand,
  ICollaborationResult,
  IMessageAuthor,
} from '../../contracts/collaboration/index.js';
import {
  assertRequestAuthority,
  assertScopesAllowed,
  collaborationConflict,
  collaborationForbidden,
} from '../../collaboration/grants/index.js';
import { COLLABORATION_FANOUT_BATCH_SIZE } from '../../collaboration/index.js';

import {
  effectivePermissions,
  readGrant,
  readRequest,
  readStream,
  requireActiveAgent,
} from './authority.js';
import {
  MESSAGE_METADATA_COLUMNS,
  REQUEST_METADATA_COLUMNS,
  DELIVERY_COLUMNS,
} from './constants.js';
import { toMessageSummary, toRequestSummary, toDelivery } from './transformers.js';
import { authorizeRecipient, ensureDelivery } from './requests.js';
import type { ICollaborationContext } from './types.js';

/**
 * Advances one durable subscriber batch. Delivery rows and its position commit together.
 * @returns Whether a message was processed, so recovery can yield between bounded transactions.
 */
export const fanoutBatch = (database: DatabaseSync): boolean => {
  const row = database
    .prepare(
      `SELECT id, sequence, task_id, stream_id, author_agent_id, fanout_after_sequence, fanout_through_sequence
    FROM hq_message WHERE fanout_complete = 0 ORDER BY sequence LIMIT 1`,
    )
    .get();
  if (!row) return false;
  const message = z
    .object({
      id: z.string(),
      sequence: z.number(),
      task_id: z.string(),
      stream_id: z.string(),
      author_agent_id: z.string().nullable(),
      fanout_after_sequence: z.number(),
      fanout_through_sequence: z.number(),
    })
    .parse(row);
  const subscriptions = database
    .prepare(
      `SELECT sequence, agent_id FROM hq_subscription
    WHERE stream_id = ? AND is_active = 1 AND notify = 1 AND sequence > ? AND sequence <= ?
    ORDER BY sequence LIMIT ?`,
    )
    .all(
      message.stream_id,
      message.fanout_after_sequence,
      message.fanout_through_sequence,
      COLLABORATION_FANOUT_BATCH_SIZE,
    );
  const last = subscriptions.at(-1);
  const after = last ? z.number().parse(last.sequence) : message.fanout_through_sequence;
  database
    .prepare(
      `INSERT INTO hq_delivery (task_id, message_id, message_sequence, recipient_agent_id)
    SELECT ?, ?, ?, s.agent_id FROM hq_subscription s JOIN hq_task_agent a ON a.task_id = s.task_id AND a.agent_id = s.agent_id
    WHERE s.stream_id = ? AND s.is_active = 1 AND s.notify = 1 AND s.sequence > ? AND s.sequence <= ?
    AND s.starting_sequence < ? AND a.is_revoked = 0 AND (? IS NULL OR s.agent_id != ?)
    ON CONFLICT(message_id, recipient_agent_id) DO NOTHING`,
    )
    .run(
      message.task_id,
      message.id,
      message.sequence,
      message.stream_id,
      message.fanout_after_sequence,
      after,
      message.sequence,
      message.author_agent_id,
      message.author_agent_id,
    );
  database
    .prepare('UPDATE hq_message SET fanout_after_sequence = ?, fanout_complete = ? WHERE id = ?')
    .run(after, Number(subscriptions.length < COLLABORATION_FANOUT_BATCH_SIZE), message.id);
  return true;
};

/** Inserts transport-owned immutable content, including results collected after revocation. */
export const insertMessage = (
  database: DatabaseSync,
  taskId: string,
  author: IMessageAuthor,
  command: Pick<
    Extract<ICollaborationCommand, { kind: 'message-publish' }>,
    'id' | 'streamId' | 'messageKind' | 'summary' | 'body' | 'references' | 'replyToMessageId'
  >,
) => {
  const through = z
    .number()
    .parse(
      database
        .prepare(
          'SELECT coalesce(max(sequence), 0) AS boundary FROM hq_subscription WHERE stream_id = ? AND is_active = 1 AND notify = 1',
        )
        .get(command.streamId)?.boundary,
    );
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO hq_message (id, task_id, stream_id, author, author_agent_id, kind, summary, body, artifact_references, reply_to_message_id, fanout_through_sequence, fanout_complete, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      command.id,
      taskId,
      command.streamId,
      JSON.stringify(author),
      author.kind === 'agent' ? author.agentId : null,
      command.messageKind,
      command.summary,
      command.body,
      JSON.stringify(command.references),
      command.replyToMessageId,
      through,
      Number(through === 0),
      now,
    );
  return toMessageSummary(
    database
      .prepare(`SELECT ${MESSAGE_METADATA_COLUMNS} FROM hq_message m WHERE m.id = ?`)
      .get(command.id),
  );
};

/**
 * Publishes immutable bounded content and root-request metadata with its initial delivery intent.
 * @returns Metadata only; no native action is dispatched.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const publishMessage = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: Extract<ICollaborationCommand, { kind: 'message-publish' }>,
): ICollaborationResult => {
  if (context.actor.kind === 'agent') requireActiveAgent(context);
  const stream = readStream(database, context.task.id, command.streamId);
  const reply =
    command.replyToMessageId === null
      ? null
      : database
          .prepare('SELECT id FROM hq_message WHERE task_id = ? AND id = ?')
          .get(context.task.id, command.replyToMessageId);
  if (command.replyToMessageId !== null && !reply) return collaborationForbidden();
  if (stream.isArchived) {
    if (command.messageKind !== 'reply' || command.replyToMessageId === null)
      return collaborationConflict();
    const request = readRequest(database, context.task.id, command.replyToMessageId);
    if (request.state === 'resolved' || request.state === 'canceled')
      return collaborationConflict();
  }
  const specification = command.request;
  if (specification !== null) {
    const grant =
      specification.grantId === null
        ? null
        : readGrant(database, context.task.id, specification.grantId);
    // Eligibility is selected on claim; publication still verifies exact scope, mode and revision.
    assertRequestAuthority(
      specification,
      context.task.id,
      specification.targetAgentId ?? '',
      context.task.policy,
      specification.claimable && grant ? { ...grant, eligibleAgentIds: null } : grant,
    );
    if (context.member) {
      const permissions = effectivePermissions(context.member, context.task);
      if (specification.effects.some((effect) => !permissions.effects.includes(effect)))
        return collaborationForbidden();
      assertScopesAllowed(
        specification.scopes,
        permissions.workspaceRoots.map((workspaceRoot) => ({ workspaceRoot, pathPrefixes: [''] })),
      );
    }
    if (specification.targetAgentId !== null)
      authorizeRecipient(database, context, specification, specification.targetAgentId, false);
    if (specification.returnStreamId !== undefined)
      readStream(database, context.task.id, specification.returnStreamId);
  }
  const now = Date.now();
  const message = insertMessage(database, context.task.id, context.actor, command);
  if (specification !== null) {
    database
      .prepare(
        `INSERT INTO hq_request (id, sequence, task_id, stream_id, specification, target_agent_id, is_claimable, state, grant_id, grant_revision, skill_name, skill_mode, result_references, return_stream_id, pending_action_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      )
      .run(
        command.id,
        message.sequence,
        context.task.id,
        stream.id,
        JSON.stringify(specification),
        specification.targetAgentId,
        Number(specification.claimable),
        specification.grantId,
        specification.grantRevision,
        specification.skill?.name ?? null,
        specification.skill?.mode ?? null,
        specification.returnStreamId ?? stream.id,
        specification.claimable ? null : command.id,
        now,
        now,
      );
    if (specification.targetAgentId !== null)
      ensureDelivery(
        database,
        context.task.id,
        command.id,
        message.sequence,
        specification.targetAgentId,
      );
  }
  const request =
    specification === null
      ? null
      : toRequestSummary(
          database
            .prepare(
              `SELECT ${REQUEST_METADATA_COLUMNS} FROM hq_request r JOIN hq_message m ON m.id = r.id WHERE r.id = ?`,
            )
            .get(command.id),
        );
  return { kind: 'publication', message, request };
};

/**
 * Records explicit acknowledgement without advancing read position or resolving work.
 * @returns The independently tracked delivery metadata.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const acknowledgeMessage = (
  database: DatabaseSync,
  context: ICollaborationContext,
  messageId: string,
): ICollaborationResult => {
  if (context.actor.kind !== 'agent') return collaborationForbidden();
  const delivery = database
    .prepare(
      `SELECT ${DELIVERY_COLUMNS} FROM hq_delivery WHERE task_id = ? AND message_id = ? AND recipient_agent_id = ?`,
    )
    .get(context.task.id, messageId, context.actor.agentId);
  if (!delivery) return collaborationForbidden();
  database
    .prepare(
      'UPDATE hq_delivery SET acknowledged_at = coalesce(acknowledged_at, ?) WHERE message_id = ? AND recipient_agent_id = ?',
    )
    .run(Date.now(), messageId, context.actor.agentId);
  return {
    kind: 'delivery',
    delivery: toDelivery(
      database
        .prepare(
          `SELECT ${DELIVERY_COLUMNS} FROM hq_delivery WHERE message_id = ? AND recipient_agent_id = ?`,
        )
        .get(messageId, context.actor.agentId),
    ),
  };
};
