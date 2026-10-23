import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type { ICollaborationResult } from '../../contracts/collaboration/index.js';
import { collaborationConflict, collaborationForbidden } from '../../collaboration/grants/index.js';

import {
  readStream,
  readMember,
  readSubscription,
  requireActiveAgent,
  effectivePermissions,
} from './authority.js';
import type { ICollaborationContext, IStreamMutation } from './types.js';

/** Reads the indexed stream boundary without inspecting publication bodies. */
export const streamHighWater = (database: DatabaseSync, streamId: string): number =>
  z
    .number()
    .int()
    .nonnegative()
    .parse(
      database
        .prepare(
          'SELECT coalesce(max(sequence), 0) AS boundary FROM hq_message WHERE stream_id = ?',
        )
        .get(streamId)?.boundary,
    );

/**
 * Applies stream ownership, self/authorized-peer interest, and independent read-position changes.
 * @returns Current durable metadata without submitting any native input.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const mutateStream = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: IStreamMutation,
): ICollaborationResult => {
  const { actor, task } = context;
  if (command.kind === 'stream-create') {
    if (actor.kind === 'agent') requireActiveAgent(context);
    database
      .prepare(
        'INSERT INTO hq_stream (id, task_id, title, purpose, creator, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      )
      .run(command.id, task.id, command.title, command.purpose, JSON.stringify(actor), Date.now());
    return { kind: 'stream', stream: readStream(database, task.id, command.id) };
  }
  const stream = readStream(database, task.id, command.streamId);
  if (command.kind === 'stream-archive') {
    if (actor.kind === 'agent') {
      requireActiveAgent(context);
      if (stream.creator.kind !== 'agent' || stream.creator.agentId !== actor.agentId)
        return collaborationForbidden();
    }
    database
      .prepare('UPDATE hq_stream SET is_archived = ? WHERE id = ?')
      .run(Number(command.isArchived), stream.id);
    return { kind: 'stream', stream: readStream(database, task.id, stream.id) };
  }
  const highWater = streamHighWater(database, stream.id);
  if (command.kind === 'subscription-advance') {
    if (actor.kind !== 'agent') return collaborationForbidden();
    const subscription = readSubscription(database, task.id, stream.id, actor.agentId);
    if (
      !subscription?.isActive ||
      command.throughSequence < subscription.readSequence ||
      command.throughSequence > highWater
    )
      return collaborationConflict();
    database
      .prepare(
        'UPDATE hq_subscription SET read_sequence = ?, updated_at = ? WHERE stream_id = ? AND agent_id = ?',
      )
      .run(command.throughSequence, Date.now(), stream.id, actor.agentId);
    return {
      kind: 'subscription',
      subscription: readSubscription(database, task.id, stream.id, actor.agentId),
    };
  }
  const target = readMember(database, task.id, command.agentId);
  if (target.isRevoked) return collaborationForbidden();
  if (
    actor.kind === 'agent' &&
    actor.agentId !== target.agentId &&
    (!context.member || !effectivePermissions(context.member, task).canManagePeerSubscriptions)
  )
    return collaborationForbidden();
  const previous = readSubscription(database, task.id, stream.id, target.agentId);
  if (command.historyLimit !== undefined && (!command.isActive || previous?.isActive))
    return collaborationConflict();
  let startingSequence = previous?.startingSequence ?? highWater;
  let readSequence = previous?.readSequence ?? highWater;
  if (command.isActive && !previous?.isActive) {
    const historical =
      command.historyLimit === undefined
        ? undefined
        : database
            .prepare(
              'SELECT sequence FROM hq_message WHERE stream_id = ? ORDER BY sequence DESC LIMIT 1 OFFSET ?',
            )
            .get(stream.id, command.historyLimit);
    startingSequence =
      command.historyLimit === undefined
        ? highWater
        : historical === undefined
          ? 0
          : z.number().int().nonnegative().parse(historical.sequence);
    readSequence = startingSequence;
  }
  database
    .prepare(
      `INSERT INTO hq_subscription (task_id, stream_id, agent_id, is_active, notify, starting_sequence, read_sequence, established_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stream_id, agent_id) DO UPDATE SET is_active = excluded.is_active, notify = excluded.notify,
    starting_sequence = excluded.starting_sequence, read_sequence = excluded.read_sequence, established_by = excluded.established_by, updated_at = excluded.updated_at`,
    )
    .run(
      task.id,
      stream.id,
      target.agentId,
      Number(command.isActive),
      Number(command.notify),
      startingSequence,
      readSequence,
      JSON.stringify(actor),
      Date.now(),
    );
  if (command.isActive && command.notify && command.historyLimit !== undefined)
    database
      .prepare(
        `INSERT INTO hq_delivery (task_id, message_id, message_sequence, recipient_agent_id)
      SELECT task_id, id, sequence, ? FROM hq_message WHERE stream_id = ? AND sequence > ? AND sequence <= ? AND (author_agent_id IS NULL OR author_agent_id != ?)
      ORDER BY sequence LIMIT 128 ON CONFLICT(message_id, recipient_agent_id) DO NOTHING`,
      )
      .run(target.agentId, stream.id, startingSequence, highWater, target.agentId);
  return {
    kind: 'subscription',
    subscription: readSubscription(database, task.id, stream.id, target.agentId),
  };
};
