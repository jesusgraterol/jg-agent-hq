import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'jg-exception';
import { measureJsonBytes } from 'jg-utilities';
import { z } from 'zod';

import {
  MAX_REPORT_BYTES,
  ReportSummarySchema,
  type ICollaborationCommand,
  type ICollaborationResult,
  type IDispatchFailure,
} from '../../contracts/collaboration/index.js';
import { collaborationForbidden } from '../../collaboration/grants/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';
import { utf8Chunk } from '../../sessions/evidence/index.js';

import type { ICollaborationContext } from './types.js';

// exact payloads are selected separately; list and search paths never hydrate them
export const REPORT_COLUMNS =
  'id, task_id, request_id, action_id, reply_message_id, author_agent_id, provider, native_id, native_turn_id, outcome, sha256, byte_count, created_at';

/** Validates immutable report metadata independently of its stored payload. */
export const toReportSummary = (input: unknown) => {
  const row = z.record(z.string(), z.unknown()).parse(input);
  return ReportSummarySchema.parse({
    id: row.id,
    taskId: row.task_id,
    requestId: row.request_id,
    actionId: row.action_id,
    replyMessageId: row.reply_message_id,
    authorAgentId: row.author_agent_id,
    provider: row.provider,
    nativeId: row.native_id,
    nativeTurnId: row.native_turn_id,
    outcome: row.outcome,
    sha256: row.sha256,
    byteCount: row.byte_count,
    createdAt: row.created_at,
  });
};

/** Captures and hashes a fixed-capacity report without replacing malformed UTF-16. */
export const captureReport = (
  text: string,
): { payload: Buffer; sha256: string } | { failure: IDispatchFailure } => {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) return { failure: 'report-too-large' };
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + 8192, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    const part = text.slice(offset, end);
    const chunk = Buffer.from(part, 'utf8');
    if (chunk.toString('utf8') !== part) return { failure: 'report-invalid-utf8' };
    chunks.push(chunk);
    hash.update(chunk);
    offset = end;
  }
  return { payload: Buffer.concat(chunks), sha256: hash.digest('hex') };
};

/**
 * Reads only a bounded UTF-8 substring, with continuation bound to actor, report and hash.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const readReport = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: Extract<ICollaborationCommand, { kind: 'report-read' }>,
): ICollaborationResult => {
  const row = database
    .prepare(`SELECT ${REPORT_COLUMNS} FROM hq_report WHERE task_id = ? AND id = ?`)
    .get(context.task.id, command.reportId);
  if (!row) return collaborationForbidden();
  const report = toReportSummary(row);
  const scope = {
    actor: context.actor,
    taskId: context.task.id,
    reportId: report.id,
    sha256: report.sha256,
  };
  const cursor = decodeHistoryCursor(command.cursor, scope);
  let offset = 0;
  if (cursor !== undefined) {
    try {
      offset = z.number().int().positive().max(report.byteCount).parse(JSON.parse(cursor));
    } catch (cause) {
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
  }
  // The extra byte lets utf8Chunk detect an incomplete code point at the selected boundary.
  const selected = database
    .prepare('SELECT substr(payload, ?, ?) AS chunk FROM hq_report WHERE id = ?')
    .get(offset + 1, 32_769, report.id);
  const bytes = Buffer.from(z.instanceof(Uint8Array).parse(selected?.chunk));
  if (offset > 0 && bytes.length > 0 && (bytes[0]! & 0xc0) === 0x80)
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
    });
  let text = utf8Chunk(bytes, 0, 32_768);
  const make = (): ICollaborationResult => {
    const next = offset + Buffer.byteLength(text, 'utf8');
    return {
      kind: 'report',
      result: {
        report,
        text,
        offsetBytes: offset,
        isComplete: next === report.byteCount,
        nextCursor: next < report.byteCount ? encodeHistoryCursor(String(next), scope) : null,
      },
    };
  };
  while (measureJsonBytes(make(), 65_536) > 64_512 && text.length > 0)
    text = utf8Chunk(Buffer.from(text), 0, Math.floor(Buffer.byteLength(text) / 2));
  if ((text.length === 0 && offset < report.byteCount) || measureJsonBytes(make(), 65_536) > 64_512)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  return make();
};
