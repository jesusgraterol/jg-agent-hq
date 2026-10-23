import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'jg-exception';
import { measureJsonBytes, takeWithinByteBudget } from 'jg-utilities';
import { z } from 'zod';

import { TaskSummarySchema, TaskAgentSummarySchema } from '../../contracts/collaboration/index.js';

import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';
import { collaborationForbidden } from '../../collaboration/grants/index.js';
import {
  AgentIdentitySchema,
  type IAgentIdentity,
  type IAgentIdentityQuery,
  type INativeToolBinding,
} from '../../collaboration/identity/index.js';

import { taskAccess, effectivePermissions } from './authority.js';
import { TASK_METADATA_COLUMNS } from './constants.js';
import { toTaskSummary } from './transformers.js';
import { CollaborationPositionSchema } from './types.js';

/**
 * Resolves an exact controlled native binding, never an agent ID supplied by model arguments.
 * @returns The immutable managed identity and its admitted workspace.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readNativeAgent = (
  database: DatabaseSync,
  binding: INativeToolBinding,
  runtimeEpoch: string,
): { agentId: string; workspaceRoot: string } => {
  if (binding.runtimeEpoch !== runtimeEpoch) return collaborationForbidden();
  const row = database
    .prepare(
      `SELECT id, workspace_root, active_turn_id, state FROM hq_thread
    WHERE provider = ? AND native_id = ? AND runtime_epoch = ? AND ownership = 'managed' AND is_archived = 0`,
    )
    .get(binding.provider, binding.nativeId, runtimeEpoch);
  if (
    !row ||
    ['inactive', 'unknown', 'creating', 'stopping'].includes(z.string().parse(row.state)) ||
    (binding.turnId !== undefined && row.active_turn_id !== binding.turnId)
  )
    return collaborationForbidden();
  return { agentId: z.uuid().parse(row.id), workspaceRoot: z.string().parse(row.workspace_root) };
};

/**
 * Reads bounded membership discovery and selected task permissions from current durable state.
 * @returns Compact stable identity; a task selector alone never grants membership.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const readAgentIdentity = (
  database: DatabaseSync,
  query: IAgentIdentityQuery,
  runtimeEpoch: string,
): IAgentIdentity => {
  const native = readNativeAgent(database, query.binding, runtimeEpoch);
  const scope = {
    agentId: native.agentId,
    provider: query.binding.provider,
    nativeId: query.binding.nativeId,
    runtimeEpoch,
    taskId: query.taskId,
    limit: query.limit,
  };
  const encoded = decodeHistoryCursor(query.cursor, scope);
  let position: z.infer<typeof CollaborationPositionSchema> | undefined;
  if (encoded !== undefined) {
    try {
      position = CollaborationPositionSchema.parse(JSON.parse(encoded));
    } catch (cause) {
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
  }
  const columns = TASK_METADATA_COLUMNS.split(', ')
    .map((column) => `t.${column}`)
    .join(', ');
  const rows = database
    .prepare(
      `SELECT ${columns}, a.sequence AS membership_sequence FROM hq_task_agent a
    JOIN hq_collaboration_task t ON t.id = a.task_id WHERE a.agent_id = ? AND a.is_revoked = 0
    AND a.sequence <= ? AND a.sequence < ? ORDER BY a.sequence DESC LIMIT ?`,
    )
    .all(
      native.agentId,
      position?.boundary ?? Number.MAX_SAFE_INTEGER,
      position?.sequence ?? Number.MAX_SAFE_INTEGER,
      query.limit + 1,
    );
  const taskId =
    query.taskId ??
    (position === undefined && rows.length === 1 ? z.uuid().parse(rows[0]!.id) : undefined);
  const context =
    taskId === undefined
      ? null
      : taskAccess(database, { kind: 'agent', agentId: native.agentId }, taskId);
  const member = context?.member ?? null;
  const task = context?.task ?? null;
  const base: IAgentIdentity = {
    agentId: native.agentId,
    provider: query.binding.provider,
    nativeId: query.binding.nativeId,
    workspaceRoot: native.workspaceRoot,
    runtimeEpoch,
    selectedTask: task === null ? null : TaskSummarySchema.parse(task),
    membership: member === null ? null : TaskAgentSummarySchema.parse(member),
    purpose:
      task === null
        ? null
        : z
            .string()
            .nullable()
            .parse(
              database
                .prepare(
                  'SELECT purpose FROM hq_agent_spawn WHERE child_agent_id = ? AND task_id = ?',
                )
                .get(native.agentId, task.id)?.purpose ?? null,
            ),
    permissions: member !== null && task !== null ? effectivePermissions(member, task) : null,
    tasks: [],
    nextCursor: null,
  };
  const candidates = rows.slice(0, query.limit).map(toTaskSummary);
  const boundary = position?.boundary ?? z.number().parse(rows[0]?.membership_sequence ?? 0);
  const cursor = (count: number) =>
    encodeHistoryCursor(
      JSON.stringify({
        boundary,
        sequence: z.number().parse(rows[count - 1]!.membership_sequence),
      }),
      scope,
    );
  const selected = takeWithinByteBudget(candidates, {
    maxBytes: 64_512,
    measurePage: (page, bytes) =>
      bytes +
      measureJsonBytes({ ...base, nextCursor: page.length ? cursor(page.length) : null }, 65_536) -
      2,
  });
  if ((candidates.length > 0 && selected.length === 0) || measureJsonBytes(base, 65_536) > 64_512)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  return AgentIdentitySchema.parse({
    ...base,
    tasks: selected,
    nextCursor:
      selected.length > 0 && (rows.length > query.limit || selected.length < candidates.length)
        ? cursor(selected.length)
        : null,
  });
};
