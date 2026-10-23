import type { DatabaseSync } from 'node:sqlite';
import { truncateToUtf8Bytes } from 'jg-utilities';
import { z } from 'zod';
import { isException } from 'jg-exception';

import {
  DispatchCollectionSchema,
  DispatchResponseSchema,
  type IDispatchCollection,
  type IDispatchFailure,
  type IDispatchResponse,
} from '../../contracts/collaboration/index.js';
import { TurnResultSchema } from '../../contracts/results/index.js';
import { DispatchContextSchema } from '../../collaboration/dispatch/index.js';
import { collaborationConflict, collaborationForbidden } from '../../collaboration/grants/index.js';

import { readRequest, readTask, readMember } from './authority.js';
import { authorizeRecipient, ensureDelivery } from './requests.js';
import { insertMessage } from './messages.js';
import { captureReport, REPORT_COLUMNS, toReportSummary } from './reports.js';
import { canRegisterWait, hasPendingChildren, refreshWait, refreshParentWait } from './waits.js';

/**
 * Atomically records exact terminal native evidence and transport-owned return delivery.
 * An uncertain send never becomes a collected success or another automatic attempt.
 * @returns The immutable collection receipt, or null while native evidence remains unsettled.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const collectDispatch = (
  database: DatabaseSync,
  taskId: string,
  requestId: string,
  actionId: string,
  runtimeEpoch: string,
): IDispatchCollection | null => {
  const row = database
    .prepare(
      `SELECT a.id, a.provider, a.thread_id, a.native_turn_id, a.delivery, a.completion,
    a.collaboration_context, a.collaboration_collection, a.created_at, t.native_id,
    t.ownership, t.runtime_epoch, t.active_turn_id, t.pending_action_id, t.state
    FROM hq_action a JOIN hq_thread t ON t.id = a.thread_id WHERE a.id = ?`,
    )
    .get(actionId);
  if (!row || row.collaboration_context === null) return collaborationForbidden();
  const context = DispatchContextSchema.parse(
    JSON.parse(z.string().parse(row.collaboration_context)),
  );
  if (
    context.taskId !== taskId ||
    context.requestId !== requestId ||
    context.pendingActionId !== actionId ||
    context.agentId !== row.thread_id
  )
    return collaborationForbidden();
  if (context.provider !== row.provider || context.nativeId !== row.native_id)
    return collaborationConflict();
  if (row.collaboration_collection !== null)
    return DispatchCollectionSchema.parse(
      JSON.parse(z.string().parse(row.collaboration_collection)),
    );
  const request = readRequest(database, taskId, requestId);
  if (request.currentActionId !== actionId || request.assigneeAgentId !== context.agentId)
    return collaborationConflict();
  const recovered =
    request.state === 'canceled' &&
    row.delivery === 'uncertain' &&
    row.ownership === 'managed' &&
    row.runtime_epoch === runtimeEpoch &&
    row.state === 'idle' &&
    row.active_turn_id === null &&
    row.pending_action_id === null
      ? database
          .prepare(
            "SELECT id FROM hq_action WHERE thread_id = ? AND runtime_epoch = ? AND kind IN ('thread-recover', 'thread-resume') AND delivery = 'acknowledged' AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1",
          )
          .get(context.agentId, runtimeEpoch, z.number().parse(row.created_at))
      : undefined;
  if (
    !recovered &&
    (row.delivery === 'uncertain' ||
      row.delivery === 'submitted' ||
      (row.delivery !== 'failed' && row.completion === null))
  )
    return null;
  let failure: IDispatchFailure | null = null;
  let response: IDispatchResponse | null = null;
  let capture: ReturnType<typeof captureReport> | null = null;
  const isInterrupted = row.completion === 'interrupted';
  if (recovered) {
    /* explicit idle ownership recovery closes only canceled work */
  } else if (row.delivery === 'failed') failure = 'delivery-failed';
  else if (row.delivery !== 'acknowledged' || row.native_turn_id === null || row.native_id === null)
    return null;
  else if (!isInterrupted) {
    const savedResult = database
      .prepare('SELECT result FROM hq_action WHERE id = ?')
      .get(actionId)?.result;
    if (savedResult === null)
      failure = row.completion === 'completed' ? 'missing-response' : 'native-failed';
    else {
      const native = TurnResultSchema.parse(JSON.parse(z.string().parse(savedResult)));
      if (native.failure === 'result-too-large') failure = 'capture-too-large';
      else if (native.failure === 'invalid-structured-output') failure = 'invalid-response';
      else if (native.failure === 'missing-result') failure = 'missing-response';
      else if (row.completion !== 'completed') failure = 'native-failed';
      else if (!native.isComplete || native.failure !== null) failure = 'invalid-response';
      else {
        const parsed = DispatchResponseSchema.safeParse(native.structuredOutput);
        if (!parsed.success) failure = 'invalid-response';
        else if (parsed.data.requestId !== requestId) failure = 'wrong-request';
        else {
          response = parsed.data;
          capture = captureReport(response.report);
          if ('failure' in capture) {
            failure = capture.failure;
            response = null;
          }
        }
      }
    }
  }
  const task = readTask(database, taskId);
  let pauseRevision: number | null = null;
  if (response?.outcome === 'paused' && request.state !== 'canceled') {
    // A report may survive revocation, but a new pause effect still needs current authority.
    const member = readMember(database, taskId, context.agentId);
    if (
      !context.specification.effects.includes('pause') ||
      task.state !== 'active' ||
      member.isRevoked ||
      member.state !== 'active'
    ) {
      failure = 'pause-not-authorized';
    } else {
      try {
        authorizeRecipient(
          database,
          { actor: { kind: 'host', operatorRef: task.ownerOperatorRef }, task, member: null },
          context.specification,
          context.agentId,
          true,
        );
        database
          .prepare(
            "UPDATE hq_task_agent SET state = 'paused', revision = revision + 1 WHERE task_id = ? AND agent_id = ?",
          )
          .run(taskId, context.agentId);
        pauseRevision = member.revision + 1;
      } catch (error) {
        if (!isException(error) || error.code !== 'JG_AGENT_HQ_COLLABORATION_FORBIDDEN')
          throw error;
        failure = 'pause-not-authorized';
      }
    }
  }
  const now = Date.now();
  if (request.state !== 'canceled' && response !== null && failure === null) {
    if (
      response.outcome === 'waiting-children' &&
      !canRegisterWait(database, request, response.childRequestIds)
    )
      failure = 'invalid-child-wait';
    else if (response.outcome === 'completed' && hasPendingChildren(database, request.id))
      failure = 'children-pending';
  }
  const savedReport =
    response !== null && capture !== null && 'payload' in capture ? { response, capture } : null;
  const references = savedReport
    ? [{ kind: 'report' as const, reportId: actionId, sha256: savedReport.capture.sha256 }]
    : [];
  const returnStreamId = z
    .uuid()
    .parse(
      database.prepare('SELECT return_stream_id FROM hq_request WHERE id = ?').get(requestId)
        ?.return_stream_id,
    );
  const reply = insertMessage(
    database,
    taskId,
    savedReport && failure === null
      ? { kind: 'agent', agentId: context.agentId }
      : { kind: 'runtime' },
    {
      id: context.replyMessageId,
      streamId: returnStreamId,
      messageKind: 'reply',
      summary:
        failure !== null
          ? 'Request failed'
          : savedReport
            ? `Request ${savedReport.response.outcome}`
            : recovered
              ? 'Canceled work reconciled'
              : isInterrupted
                ? 'Request interrupted'
                : 'Request outcome unavailable',
      body: savedReport
        ? `Assignee outcome: ${savedReport.response.outcome}. This is not approval.\n${failure ? `Runtime outcome: ${failure}.\n` : ''}Report: ${actionId}\nSHA-256: ${savedReport.capture.sha256}\nExcerpt:\n${truncateToUtf8Bytes(savedReport.response.report, 4096)}`
        : `Runtime outcome: ${recovered ? 'canceled after explicit idle ownership recovery' : isInterrupted ? 'native-interrupted' : failure}. No assignee success was recorded.`,
      references,
      replyToMessageId: requestId,
    },
  );
  if (savedReport) {
    database
      .prepare(
        `INSERT INTO hq_report (id, task_id, request_id, action_id, reply_message_id, sequence, stream_id, author_agent_id, provider, native_id, native_turn_id, outcome, payload, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        taskId,
        requestId,
        actionId,
        reply.id,
        reply.sequence,
        returnStreamId,
        context.agentId,
        z.string().parse(row.provider),
        z.string().parse(row.native_id),
        z.string().parse(row.native_turn_id),
        savedReport.response.outcome,
        savedReport.capture.payload,
        savedReport.capture.sha256,
        now,
      );
  }
  if (context.requester.kind === 'agent')
    ensureDelivery(database, taskId, reply.id, reply.sequence, context.requester.agentId);
  const state =
    request.state === 'canceled'
      ? 'canceled'
      : isInterrupted || (response?.outcome === 'paused' && failure === null)
        ? 'interrupted'
        : response?.outcome === 'waiting-children' && failure === null
          ? 'waiting-children'
          : response?.outcome === 'needs-input' && failure === null
            ? 'waiting-input'
            : 'resolved';
  const outcome =
    state === 'resolved'
      ? failure !== null || response?.outcome === 'failed'
        ? 'failed'
        : 'completed'
      : null;
  database
    .prepare(
      `UPDATE hq_request SET state = ?, outcome = ?, current_action_id = NULL, pending_action_id = NULL,
    pending_input_message_id = NULL, required_authority = ?, pause_agent_revision = ?, last_report_id = ?, result_references = ?, failure_reason = ?, dispatch_blocked_reason = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(
      state,
      outcome,
      state === 'waiting-input' ? response!.requiredAuthority : null,
      pauseRevision,
      savedReport ? actionId : request.lastReportId,
      JSON.stringify(references),
      failure,
      now,
      requestId,
    );
  if (state === 'waiting-children')
    database
      .prepare(
        'UPDATE hq_request SET child_request_ids = ?, wait_generation = wait_generation + 1, continuation_action_id = NULL WHERE id = ?',
      )
      .run(JSON.stringify(response!.childRequestIds), requestId);
  refreshWait(database, taskId, requestId);
  refreshParentWait(database, taskId, requestId);
  const report = savedReport
    ? toReportSummary(
        database.prepare(`SELECT ${REPORT_COLUMNS} FROM hq_report WHERE id = ?`).get(actionId),
      )
    : null;
  const collection: IDispatchCollection = {
    actionId,
    requestId,
    recoveryActionId: recovered ? z.uuid().parse(recovered.id) : null,
    report,
    reply,
    state,
    failureReason: failure,
  };
  database
    .prepare('UPDATE hq_action SET collaboration_collection = ? WHERE id = ?')
    .run(JSON.stringify(collection), actionId);
  return collection;
};
