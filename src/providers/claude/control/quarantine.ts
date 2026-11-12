import { z } from 'zod';

// independent lifecycle evidence; no conversation text or native request bodies are retained
const FrameSchema = z.object({ type: z.string() });
const SystemSchema = z.object({ subtype: z.string() });
const TasksSchema = z.object({
  tasks: z.array(z.object({ task_id: z.string().min(1).max(4096) })).max(1024),
});
const RequestSchema = z.object({
  request_id: z.string().min(1).max(4096),
  request: z.object({
    subtype: z.string(),
    tool_use_id: z.string().min(1).max(4096).optional(),
  }),
});
const RequestIdSchema = z.object({ request_id: z.string().min(1).max(4096) });
const ToolResultsSchema = z.object({
  message: z.object({
    content: z.array(z.object({ type: z.string(), tool_use_id: z.string().optional() })).max(128),
  }),
});
const ReplySchema = z.object({
  type: z.literal('control_response'),
  response: RequestIdSchema,
});

/**
 * Tracks bounded lifecycle evidence independently of rich interpretation, from process startup.
 * @returns Activity revisions and positive task/request proof; default zero never proves empty.
 */
export const createClaudeQuarantineMonitor = () => {
  let revision = 0;
  let areTasksKnown = false;
  let backgroundCount = 0;
  let hasUnknownRequests = false;
  const requests = new Map<string, { toolId: string | null; isOneWayReply: boolean }>();

  /** Observes one already framed message without retaining its content or acknowledging it. */
  const observe = (raw: unknown): void => {
    revision += 1;
    const frame = FrameSchema.safeParse(raw);
    if (!frame.success) {
      areTasksKnown = false;
      hasUnknownRequests = true;
      return;
    }
    if (frame.data.type === 'system') {
      const system = SystemSchema.safeParse(raw);
      if (!system.success) {
        areTasksKnown = false;
        return;
      }
      if (system.data.subtype !== 'background_tasks_changed') {
        if (
          ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(
            system.data.subtype,
          )
        )
          areTasksKnown = false;
        return;
      }
      const snapshot = TasksSchema.safeParse(raw);
      areTasksKnown = snapshot.success;
      if (snapshot.success) backgroundCount = snapshot.data.tasks.length;
    } else if (frame.data.type === 'control_request') {
      const request = RequestSchema.safeParse(raw);
      if (!request.success) {
        hasUnknownRequests = true;
        return;
      }
      const { request_id: id, request: body } = request.data;
      if (
        requests.has(id) ||
        requests.size >= 32 ||
        (body.subtype === 'can_use_tool' && !body.tool_use_id)
      ) {
        hasUnknownRequests = true;
        return;
      }
      requests.set(id, {
        toolId: body.subtype === 'can_use_tool' ? body.tool_use_id! : null,
        isOneWayReply: body.subtype === 'elicitation',
      });
    } else if (frame.data.type === 'control_cancel_request') {
      const canceled = RequestIdSchema.safeParse(raw);
      if (canceled.success) requests.delete(canceled.data.request_id);
      else hasUnknownRequests = true;
    } else if (frame.data.type === 'user' && requests.size > 0) {
      const results = ToolResultsSchema.safeParse(raw);
      if (!results.success) return;
      for (const result of results.data.message.content) {
        if (result.type !== 'tool_result' || result.tool_use_id === undefined) continue;
        for (const [id, request] of requests)
          if (request.toolId === result.tool_use_id) requests.delete(id);
      }
    }
  };

  /** Records a completed native reply write only for the protocol's correlated one-way requests. */
  const written = (raw: unknown): void => {
    revision += 1;
    const reply = ReplySchema.safeParse(raw);
    if (!reply.success) return;
    if (requests.get(reply.data.response.request_id)?.isOneWayReply)
      requests.delete(reply.data.response.request_id);
  };

  return {
    observe,
    written,
    get revision(): number {
      return revision;
    },
    get backgroundCount(): number {
      return backgroundCount;
    },
    /** @returns Whether an inventory begun at this revision can prove no tasks or native requests. */
    canStop(expectedRevision: number): boolean {
      return (
        revision === expectedRevision &&
        areTasksKnown &&
        backgroundCount === 0 &&
        requests.size === 0 &&
        !hasUnknownRequests
      );
    },
  };
};
