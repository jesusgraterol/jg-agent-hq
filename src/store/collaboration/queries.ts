import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { Exception } from 'jg-exception';
import { measureJsonBytes, takeWithinByteBudget } from 'jg-utilities';
import { z } from 'zod';

import {
  ArtifactReferenceSchema,
  type ICollaborationActor,
  type ICollaborationCommand,
  type ICollaborationResponse,
  type ICollaborationResult,
} from '../../contracts/collaboration/index.js';
import { collaborationForbidden } from '../../collaboration/grants/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';

import { readGrant, readMember, readRequest, readStream, readSubscription } from './authority.js';
import {
  TASK_METADATA_COLUMNS,
  AGENT_METADATA_COLUMNS,
  GRANT_METADATA_COLUMNS,
  STREAM_COLUMNS,
  MESSAGE_METADATA_COLUMNS,
  MESSAGE_COLUMNS,
  REQUEST_METADATA_COLUMNS,
  DELIVERY_COLUMNS,
} from './constants.js';
import {
  toTaskSummary,
  toTaskAgentSummary,
  toGrantSummary,
  toStream,
  toMessageSummary,
  toRequestSummary,
  toDelivery,
} from './transformers.js';
import { collaborationPage, readCollaborationPosition } from './utilities.js';
import type { ICollaborationContext } from './types.js';

type IRow = Record<string, SQLOutputValue>;
type IListCommand = Extract<
  ICollaborationCommand,
  {
    kind:
      | 'tasks-list'
      | 'agents-list'
      | 'grants-list'
      | 'streams-list'
      | 'messages-list'
      | 'messages-search'
      | 'requests-list'
      | 'deliveries-list';
  }
>;

/**
 * Reads a bounded indexed seek and packs its metadata prefix into the response budget.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
const pageRows = (
  database: DatabaseSync,
  actor: ICollaborationActor,
  command: IListCommand,
  sql: string,
  parameters: SQLInputValue[],
  map: (row: IRow) => unknown,
  sequenceColumn = 'sequence',
): ICollaborationResult => {
  const position = readCollaborationPosition(actor, command);
  const rows = database
    .prepare(sql)
    .all(
      ...parameters,
      position?.boundary ?? Number.MAX_SAFE_INTEGER,
      position?.sequence ?? Number.MAX_SAFE_INTEGER,
      command.limit + 1,
    );
  const entries = rows
    .slice(0, command.limit)
    .map((row) => ({ sequence: z.number().parse(row[sequenceColumn]), item: map(row) }));
  return collaborationPage(
    command.kind === 'messages-search'
      ? 'messages'
      : (command.kind.replace('-list', '') as
          | 'tasks'
          | 'agents'
          | 'grants'
          | 'streams'
          | 'messages'
          | 'requests'
          | 'deliveries'),
    actor,
    command,
    entries,
    position?.boundary ?? entries[0]?.sequence ?? 0,
    rows.length > command.limit,
  );
};

/**
 * Lists only the authenticated host's tasks in one authorized workspace.
 * @returns A bounded indexed page without loading task policies.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const listTasks = (
  database: DatabaseSync,
  actor: ICollaborationActor,
  command: Extract<ICollaborationCommand, { kind: 'tasks-list' }>,
): ICollaborationResult => {
  if (actor.kind !== 'host') return collaborationForbidden();
  return pageRows(
    database,
    actor,
    command,
    `SELECT ${TASK_METADATA_COLUMNS} FROM hq_collaboration_task WHERE owner_operator_ref = ? AND workspace_root = ? AND sequence <= ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
    [actor.operatorRef, command.workspaceRoot],
    toTaskSummary,
  );
};

/**
 * Selects one immutable bounded body and continues only the reference list when necessary.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
const messageRead = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: Extract<ICollaborationCommand, { kind: 'message-read' }>,
): ICollaborationResult => {
  const row = database
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM hq_message m WHERE m.task_id = ? AND m.id = ?`)
    .get(context.task.id, command.messageId);
  if (!row) return collaborationForbidden();
  const message = toMessageSummary(row);
  const scope = {
    actor: context.actor,
    taskId: context.task.id,
    messageId: command.messageId,
    sequence: message.sequence,
  };
  const encoded = decodeHistoryCursor(command.cursor, scope);
  let offset = 0;
  if (encoded !== undefined) {
    try {
      offset =
        z
          .number()
          .int()
          .min(1)
          .max(message.referenceCount + 1)
          .parse(JSON.parse(encoded)) - 1;
    } catch (cause) {
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
  }
  const references = z
    .array(ArtifactReferenceSchema)
    .parse(JSON.parse(z.string().parse(row.artifact_references)));
  const body = encoded === undefined ? z.string().parse(row.body) : '';
  const make = (selected: typeof references, nextCursor: string | null): ICollaborationResult => ({
    kind: 'message',
    result: {
      message,
      body,
      offsetBytes: encoded === undefined ? 0 : message.bodyBytes,
      bodyComplete: true,
      references: selected,
      referenceOffset: offset,
      nextCursor,
    },
  });
  const remaining = references.slice(offset);
  const selected = takeWithinByteBudget(remaining, {
    maxBytes: 64_512,
    measurePage: (page, bytes) =>
      bytes +
      measureJsonBytes(
        make([], encodeHistoryCursor(String(offset + page.length + 1), scope)),
        65_536,
      ) -
      2,
  });
  // A maximum-sized escaped body can use most of this page; continue its references next.
  if (remaining.length > 0 && selected.length === 0 && encoded !== undefined)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const next = offset + selected.length;
  return make(
    selected,
    next < references.length ? encodeHistoryCursor(String(next + 1), scope) : null,
  );
};

const cappedCount = (database: DatabaseSync, sql: string, parameters: SQLInputValue[]) => {
  const count = database.prepare(sql).all(...parameters).length;
  return { count: Math.min(count, 128), hasMore: count > 128 };
};

/**
 * Reads task-scoped metadata with bounded indexed retrieval and actor-bound continuation.
 * @returns A selected record or a summary page. Read access never dispatches work.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const queryCollaboration = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: ICollaborationCommand,
): ICollaborationResponse => {
  const { actor, task } = context;
  switch (command.kind) {
    case 'task-read':
      return { kind: 'task', task };
    case 'agent-read':
      return { kind: 'agent', agent: readMember(database, task.id, command.agentId) };
    case 'grant-read':
      return { kind: 'grant', grant: readGrant(database, task.id, command.grantId) };
    case 'stream-read':
      return { kind: 'stream', stream: readStream(database, task.id, command.streamId) };
    case 'subscription-read':
      readStream(database, task.id, command.streamId);
      readMember(database, task.id, command.agentId);
      return {
        kind: 'subscription',
        subscription: readSubscription(database, task.id, command.streamId, command.agentId),
      };
    case 'request-read':
      return { kind: 'request', request: readRequest(database, task.id, command.requestId) };
    case 'message-read':
      return messageRead(database, context, command);
    case 'agents-list':
      return pageRows(
        database,
        actor,
        command,
        `SELECT ${AGENT_METADATA_COLUMNS} FROM hq_task_agent a JOIN hq_thread t ON t.id = a.agent_id WHERE a.task_id = ? AND a.sequence <= ? AND a.sequence < ? ORDER BY a.sequence DESC LIMIT ?`,
        [task.id],
        toTaskAgentSummary,
      );
    case 'grants-list':
      return pageRows(
        database,
        actor,
        command,
        `SELECT ${GRANT_METADATA_COLUMNS} FROM hq_skill_grant WHERE task_id = ? AND sequence <= ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
        [task.id],
        toGrantSummary,
      );
    case 'streams-list': {
      if (command.subscribed !== undefined && actor.kind !== 'agent')
        return collaborationForbidden();
      const parameters: SQLInputValue[] = [task.id];
      let filter = '';
      if (command.isArchived !== undefined) {
        filter += ' AND s.is_archived = ?';
        parameters.push(Number(command.isArchived));
      }
      if (command.subscribed && actor.kind === 'agent')
        return pageRows(
          database,
          actor,
          command,
          `SELECT ${STREAM_COLUMNS.split(', ')
            .map((column) => `s.${column}`)
            .join(', ')}, u.sequence AS subscription_sequence
          FROM hq_subscription u CROSS JOIN hq_stream s WHERE s.id = u.stream_id AND u.task_id = ? ${filter} AND u.agent_id = ? AND u.is_active = 1
          AND u.sequence <= ? AND u.sequence < ? ORDER BY u.sequence DESC LIMIT ?`,
          [...parameters, actor.agentId],
          toStream,
          'subscription_sequence',
        );
      return pageRows(
        database,
        actor,
        command,
        `SELECT ${STREAM_COLUMNS.split(', ')
          .map((column) => `s.${column}`)
          .join(
            ', ',
          )} FROM hq_stream s WHERE s.task_id = ? ${filter} AND s.sequence <= ? AND s.sequence < ? ORDER BY s.sequence DESC LIMIT ?`,
        parameters,
        toStream,
      );
    }
    case 'messages-list':
    case 'messages-search': {
      if (command.streamId !== undefined) readStream(database, task.id, command.streamId);
      const parameters: SQLInputValue[] = [task.id];
      let filter = '';
      if (command.streamId !== undefined) {
        filter += ' AND m.stream_id = ?';
        parameters.push(command.streamId);
      }
      if (command.kind === 'messages-search') {
        const literal = `"${command.query.replaceAll('"', '""')}"`;
        const match = `task_token : "${task.id.replaceAll('-', '')}"${command.streamId ? ` AND stream_token : "${command.streamId.replaceAll('-', '')}"` : ''} AND {summary body} : ${literal}`;
        parameters.unshift(match);
        return pageRows(
          database,
          actor,
          command,
          // FTS drives the ordered seek; an ordinary join may scan/sort the entire task first.
          `SELECT ${MESSAGE_METADATA_COLUMNS} FROM hq_message_search CROSS JOIN hq_message m WHERE m.sequence = hq_message_search.rowid AND hq_message_search MATCH ? AND m.task_id = ? ${filter} AND hq_message_search.rowid <= ? AND hq_message_search.rowid < ? ORDER BY hq_message_search.rowid DESC LIMIT ?`,
          parameters,
          toMessageSummary,
        );
      }
      return pageRows(
        database,
        actor,
        command,
        `SELECT ${MESSAGE_METADATA_COLUMNS} FROM hq_message m WHERE m.task_id = ? ${filter} AND m.sequence <= ? AND m.sequence < ? ORDER BY m.sequence DESC LIMIT ?`,
        parameters,
        toMessageSummary,
      );
    }
    case 'requests-list': {
      const filter = command.state === undefined ? '' : ' AND r.state = ?';
      const parameters: SQLInputValue[] = [task.id];
      if (command.state !== undefined) parameters.push(command.state);
      if (command.agentId === undefined)
        return pageRows(
          database,
          actor,
          command,
          `SELECT ${REQUEST_METADATA_COLUMNS} FROM hq_request r JOIN hq_message m ON m.id = r.id WHERE r.task_id = ? ${filter} AND r.sequence <= ? AND r.sequence < ? ORDER BY r.sequence DESC LIMIT ?`,
          parameters,
          toRequestSummary,
        );
      readMember(database, task.id, command.agentId);
      const position = readCollaborationPosition(actor, command);
      const seek = [
        position?.boundary ?? Number.MAX_SAFE_INTEGER,
        position?.sequence ?? Number.MAX_SAFE_INTEGER,
        command.limit + 1,
      ];
      const rows = ['target_agent_id', 'assignee_agent_id'].flatMap((column) =>
        database
          .prepare(
            `SELECT ${REQUEST_METADATA_COLUMNS} FROM hq_request r JOIN hq_message m ON m.id = r.id WHERE r.task_id = ? ${filter} AND r.${column} = ? AND r.sequence <= ? AND r.sequence < ? ORDER BY r.sequence DESC LIMIT ?`,
          )
          .all(...parameters, command.agentId!, ...seek),
      );
      const unique = [
        ...new Map(rows.map((row) => [z.number().parse(row.sequence), row])).entries(),
      ].sort((a, b) => b[0] - a[0]);
      const entries = unique
        .slice(0, command.limit)
        .map(([sequence, row]) => ({ sequence, item: toRequestSummary(row) }));
      return collaborationPage(
        'requests',
        actor,
        command,
        entries,
        position?.boundary ?? entries[0]?.sequence ?? 0,
        unique.length > command.limit,
      );
    }
    case 'deliveries-list': {
      const recipient =
        command.recipientAgentId ?? (actor.kind === 'agent' ? actor.agentId : undefined);
      if (actor.kind === 'agent' && recipient !== actor.agentId) return collaborationForbidden();
      if (recipient !== undefined) readMember(database, task.id, recipient);
      const parameters: SQLInputValue[] = [task.id];
      let filter = command.pendingOnly ? ' AND delivered_at IS NULL' : '';
      if (recipient !== undefined) {
        filter += ' AND recipient_agent_id = ?';
        parameters.push(recipient);
      }
      return pageRows(
        database,
        actor,
        command,
        `SELECT ${DELIVERY_COLUMNS} FROM hq_delivery WHERE task_id = ? ${filter} AND sequence <= ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
        parameters,
        toDelivery,
      );
    }
    case 'status': {
      const recipient = actor.kind === 'agent' ? actor.agentId : null;
      const pendingRequests =
        recipient === null
          ? cappedCount(
              database,
              "SELECT 1 FROM hq_request WHERE task_id = ? AND state IN ('open','claimed','waiting-children','waiting-input','interrupted') LIMIT 129",
              [task.id],
            )
          : (() => {
              const ids = ['target_agent_id', 'assignee_agent_id'].flatMap((column) =>
                database
                  .prepare(
                    `SELECT id FROM hq_request WHERE task_id = ? AND ${column} = ? AND state IN ('open','claimed','waiting-children','waiting-input','interrupted') LIMIT 129`,
                  )
                  .all(task.id, recipient)
                  .map((row) => row.id),
              );
              const count = new Set(ids).size;
              return { count: Math.min(count, 128), hasMore: count > 128 };
            })();
      return {
        kind: 'status',
        status: {
          taskId: task.id,
          state: task.state,
          policyRevision: task.policyRevision,
          lifecycleRevision: task.lifecycleRevision,
          pendingRequests,
          pendingDeliveries: cappedCount(
            database,
            `SELECT 1 FROM hq_delivery WHERE task_id = ? AND delivered_at IS NULL ${recipient === null ? '' : 'AND recipient_agent_id = ?'} LIMIT 129`,
            recipient === null ? [task.id] : [task.id, recipient],
          ),
          pendingFanout: cappedCount(
            database,
            'SELECT 1 FROM hq_message WHERE task_id = ? AND fanout_complete = 0 LIMIT 129',
            [task.id],
          ),
          fanoutFailure: null,
        },
      };
    }
    default:
      return collaborationForbidden();
  }
};
