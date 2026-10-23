import type { DatabaseSync } from 'node:sqlite';
import { truncateToUtf8Bytes } from 'jg-utilities';
import { z } from 'zod';

import type {
  ICollaborationCommand,
  ICollaborationResult,
  IMessageSummary,
} from '../../contracts/collaboration/index.js';

import { readStream } from './authority.js';
import { MESSAGE_METADATA_COLUMNS } from './constants.js';
import { toMessageSummary, toContentText } from './transformers.js';
import { collaborationPage, readCollaborationPosition } from './utilities.js';
import type { ICollaborationContext } from './types.js';

/**
 * Merges two bounded FTS-driven seeks, attaching matching report excerpts to their stream replies.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const searchMessages = (
  database: DatabaseSync,
  context: ICollaborationContext,
  command: Extract<ICollaborationCommand, { kind: 'messages-search' }>,
): ICollaborationResult => {
  if (command.streamId !== undefined) readStream(database, context.task.id, command.streamId);
  const position = readCollaborationPosition(context.actor, command);
  const scope = `task_token : "${context.task.id.replaceAll('-', '')}"${command.streamId ? ` AND stream_token : "${command.streamId.replaceAll('-', '')}"` : ''}`;
  const literal = `"${command.query.replaceAll('"', '""')}"`;
  const seek = [
    position?.boundary ?? Number.MAX_SAFE_INTEGER,
    position?.sequence ?? Number.MAX_SAFE_INTEGER,
    command.limit + 1,
  ];
  const messages = database
    .prepare(
      `SELECT ${MESSAGE_METADATA_COLUMNS} FROM hq_message_search CROSS JOIN hq_message m
    WHERE m.sequence = hq_message_search.rowid AND hq_message_search MATCH ? AND m.task_id = ?
    AND hq_message_search.rowid <= ? AND hq_message_search.rowid < ? ORDER BY hq_message_search.rowid DESC LIMIT ?`,
    )
    .all(`${scope} AND {summary body} : ${literal}`, context.task.id, ...seek);
  const reports = database
    .prepare(
      `SELECT ${MESSAGE_METADATA_COLUMNS}, hq_report.id AS report_id, hq_report.sha256 AS report_sha256,
    CAST(substr(snippet(hq_report_search, 2, '', '', ' … ', 16), 1, 1024) AS BLOB) AS report_excerpt
    FROM hq_report_search CROSS JOIN hq_report CROSS JOIN hq_message m
    WHERE hq_report.sequence = hq_report_search.rowid AND m.sequence = hq_report.sequence
    AND hq_report_search MATCH ? AND hq_report.task_id = ?
    AND hq_report_search.rowid <= ? AND hq_report_search.rowid < ? ORDER BY hq_report_search.rowid DESC LIMIT ?`,
    )
    .all(`${scope} AND payload : ${literal}`, context.task.id, ...seek);
  const hits = new Map<number, IMessageSummary>();
  for (const row of messages) {
    const message = toMessageSummary(row);
    hits.set(message.sequence, message);
  }
  for (const row of reports) {
    const message = toMessageSummary(row);
    hits.set(message.sequence, {
      ...message,
      reportMatch: {
        reportId: z.uuid().parse(row.report_id),
        sha256: z.string().parse(row.report_sha256),
        excerpt: truncateToUtf8Bytes(toContentText(row.report_excerpt), 1024),
      },
    });
  }
  const ordered = [...hits.values()].sort((a, b) => b.sequence - a.sequence);
  return collaborationPage(
    'messages',
    context.actor,
    command,
    ordered.slice(0, command.limit).map((item) => ({ sequence: item.sequence, item })),
    position?.boundary ?? ordered[0]?.sequence ?? 0,
    ordered.length > command.limit ||
      messages.length > command.limit ||
      reports.length > command.limit,
  );
};
