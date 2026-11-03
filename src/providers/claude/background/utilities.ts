import {
  BackgroundRecordSchema,
  BackgroundResultSchema,
  ContentBlockSchema,
  StopInputSchema,
  TaskIdSchema,
  TaskStatusSchema,
  type IBackgroundEvents,
} from './types.js';

// the tools that stop a background task by its ID
const STOP_TOOLS = new Set(['TaskStop', 'KillShell']);

// a task notification names the task it ends; the block holds its other details
const NOTIFICATION_PATTERN = /<task-notification>[\s\S]*?<task-id>([^<]*)<\/task-id>/gu;

// the tasks the task notifications in a text end
const readNotifiedTasks = (text: string): string[] =>
  [...text.matchAll(NOTIFICATION_PATTERN)].flatMap(
    ([, id]) => TaskIdSchema.safeParse(id?.trim()).data ?? [],
  );

// a message's content blocks, without the ones in another shape
const readBlocks = (content: unknown) =>
  Array.isArray(content)
    ? content.flatMap((block) => ContentBlockSchema.safeParse(block).data ?? [])
    : [];

/**
 * Reads what one Claude Code transcript record says about the session's background tasks:
 * - **Starts:** a tool result that moved a command to the background, or launched an agent,
 *   written at or after `startedAt` when one is given.
 * - **Ends:** a task notification, in a message or a queued input, and a status record whose
 *   status isn't `running`.
 * - **Stops:** a TaskStop or KillShell call, by its tool use ID and the task it names, and each
 *   tool result's success, which the caller pairs with the call in either order.
 *
 * Sidechain records belong to a subagent and request copies repeat other records, so both say
 * nothing.
 * @param input The parsed record.
 * @param startedAt When the session's Claude process started, in Unix milliseconds, or null.
 * @returns The record's starts, ends, stop calls and tool results.
 */
export const readBackgroundEvents = (
  input: unknown,
  startedAt: number | null,
): IBackgroundEvents => {
  const events: IBackgroundEvents = { starts: [], ends: [], stopCalls: [], results: [] };
  const record = BackgroundRecordSchema.safeParse(input).data;
  if (!record || record.isSidechain === true || record.type === 'api-request-blob') return events;
  if (record.type === 'queue-operation' && typeof record.content === 'string')
    events.ends.push(...readNotifiedTasks(record.content));
  if (record.type === 'attachment') {
    const status = TaskStatusSchema.safeParse(record.attachment).data;
    if (status && status.status !== 'running') events.ends.push(status.taskId);
  }
  const content = record.message?.content;
  if (record.type === 'assistant')
    for (const block of readBlocks(content)) {
      if (block.type !== 'tool_use' || !block.id || !STOP_TOOLS.has(block.name ?? '')) continue;
      const input = StopInputSchema.safeParse(block.input).data;
      const taskId = input?.task_id ?? input?.shell_id;
      if (taskId) events.stopCalls.push({ toolUseId: block.id, taskId });
    }
  if (record.type !== 'user') return events;
  if (typeof content === 'string') events.ends.push(...readNotifiedTasks(content));
  for (const block of readBlocks(content)) {
    if (block.type === 'text' && block.text) events.ends.push(...readNotifiedTasks(block.text));
    if (block.type === 'tool_result' && block.tool_use_id)
      events.results.push({ toolUseId: block.tool_use_id, isSuccess: block.is_error !== true });
  }
  const result = BackgroundResultSchema.safeParse(record.toolUseResult).data;
  const taskId =
    result?.backgroundTaskId ?? (result?.isAsync === true ? result.agentId : undefined);
  const writtenAt = Date.parse(record.timestamp ?? '');
  if (taskId && (startedAt === null || (Number.isFinite(writtenAt) && writtenAt >= startedAt)))
    events.starts.push(taskId);
  return events;
};
