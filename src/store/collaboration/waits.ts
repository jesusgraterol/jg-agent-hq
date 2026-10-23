import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  ContinuationSchema,
  CollaborationActorSchema,
  type ICollaborationRequestRecord,
  type IContinuation,
} from '../../contracts/collaboration/index.js';
import { utf8Chunk } from '../../sessions/evidence/index.js';

import { readRequest } from './authority.js';

/** Reads at most 32 primary-key-selected child states and fixed-size report excerpts. */
const selectChildren = (
  database: DatabaseSync,
  parent: ICollaborationRequestRecord,
  ids: string[],
): IContinuation['children'] | null => {
  const select = database.prepare(`SELECT r.id, r.task_id, r.parent_request_id, r.parent_action_id,
    r.state, r.outcome, r.last_action_id, r.required_authority, r.failure_reason,
    r.clarification_consumed_action_id, m.author, parent_action.thread_id AS parent_agent_id,
    json_extract(parent_action.collaboration_context, '$.requestId') AS admitted_parent_id, hq_report.id AS report_id,
    hq_report.sha256 AS report_sha256, substr(hq_report.payload, 1, 65) AS excerpt
    FROM hq_request r JOIN hq_message m ON m.id = r.id
    JOIN hq_action parent_action ON parent_action.id = r.parent_action_id
    LEFT JOIN hq_report ON hq_report.id = r.last_report_id WHERE r.id = ?`);
  const children: IContinuation['children'] = [];
  for (const id of ids) {
    const row = select.get(id);
    if (
      !row ||
      row.task_id !== parent.taskId ||
      row.parent_request_id !== parent.id ||
      row.parent_action_id === null
    )
      return null;
    const author = CollaborationActorSchema.parse(JSON.parse(z.string().parse(row.author)));
    if (
      author.kind !== 'agent' ||
      author.agentId !== row.parent_agent_id ||
      row.admitted_parent_id !== parent.id
    )
      return null;
    children.push(
      ContinuationSchema.shape.children.element.parse({
        requestId: id,
        state: row.state,
        outcome: row.outcome,
        actionId: row.last_action_id,
        report: row.report_id === null ? null : { id: row.report_id, sha256: row.report_sha256 },
        requiredAuthority: row.required_authority,
        failureReason: row.failure_reason,
        excerpt:
          row.excerpt === null
            ? ''
            : utf8Chunk(Buffer.from(z.instanceof(Uint8Array).parse(row.excerpt)), 0, 64),
        isClarification:
          row.state === 'waiting-input' &&
          row.required_authority === 'requester' &&
          author.agentId === parent.assigneeAgentId &&
          row.last_action_id !== row.clarification_consumed_action_id,
      }),
    );
  }
  return children;
};

/** Validates direct-child waits and prevents dropping an unresolved recorded dependency. */
export const canRegisterWait = (
  database: DatabaseSync,
  parent: ICollaborationRequestRecord,
  ids: string[],
): boolean => {
  const children = selectChildren(database, parent, ids);
  if (children === null) return false;
  const previous = selectChildren(database, parent, parent.childRequestIds);
  return (
    previous !== null &&
    previous.every(
      (child) => ['resolved', 'canceled'].includes(child.state) || ids.includes(child.requestId),
    )
  );
};

/** Resolves only the recorded wait condition; arbitrary stream traffic cannot trigger a turn. */
export const readContinuation = (
  database: DatabaseSync,
  parent: ICollaborationRequestRecord,
): IContinuation | null => {
  if (parent.childRequestIds.length === 0 || parent.waitGeneration === 0) return null;
  const children = selectChildren(database, parent, parent.childRequestIds);
  if (children === null) return null;
  const isTerminal = children.every((child) => ['resolved', 'canceled'].includes(child.state));
  if (!isTerminal && !children.some((child) => child.isClarification)) return null;
  return {
    generation: parent.waitGeneration,
    kind: isTerminal ? 'terminal-results' : 'clarification',
    children,
  };
};

/**
 * Tests readiness without taking a writer lock when a wait needs no state change.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const canReserveContinuation = (
  database: DatabaseSync,
  taskId: string,
  requestId: string,
): boolean => {
  const parent = readRequest(database, taskId, requestId);
  return (
    parent.state === 'waiting-children' &&
    parent.currentActionId === null &&
    parent.pendingActionId === null &&
    parent.continuationActionId === null &&
    readContinuation(database, parent) !== null
  );
};

/**
 * Reserves one existing-ledger action identity per generation in the caller's transaction.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const refreshWait = (database: DatabaseSync, taskId: string, requestId: string): void => {
  if (!canReserveContinuation(database, taskId, requestId)) return;
  const id = randomUUID();
  database
    .prepare(
      'UPDATE hq_request SET continuation_action_id = ?, pending_action_id = ?, dispatch_blocked_reason = NULL, updated_at = ? WHERE id = ?',
    )
    .run(id, id, Date.now(), requestId);
};

/**
 * Rechecks a direct parent after a result, clarification or explicit child cancellation.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const refreshParentWait = (
  database: DatabaseSync,
  taskId: string,
  requestId: string,
): void => {
  const parent = database
    .prepare('SELECT parent_request_id FROM hq_request WHERE task_id = ? AND id = ?')
    .get(taskId, requestId)?.parent_request_id;
  if (typeof parent === 'string') refreshWait(database, taskId, parent);
};

/** Checks unfinished direct children through the parent/state index without loading their bodies. */
export const hasPendingChildren = (database: DatabaseSync, requestId: string): boolean =>
  database
    .prepare(
      "SELECT 1 FROM hq_request WHERE parent_request_id = ? AND state IN ('open', 'claimed', 'waiting-children', 'waiting-input', 'interrupted') LIMIT 1",
    )
    .get(requestId) !== undefined;
