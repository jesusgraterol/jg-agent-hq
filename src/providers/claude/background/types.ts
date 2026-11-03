import { z } from 'zod';

// a background task's ID, as Claude Code names a command it moved to the background or an agent
export const TaskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/u)
  .meta({ description: 'The ID Claude Code gives a background task.' });

/*
 * The fields of one transcript record that say a background task started or ended, as Claude Code
 * 2.1.317 writes them; other fields pass unread, and a field in another shape reads as absent.
 */
export const BackgroundRecordSchema = z.object({
  type: z.string().optional(),
  isSidechain: z.boolean().optional(),
  timestamp: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  message: z.object({ content: z.unknown().optional() }).optional(),
  content: z.unknown().optional(),
  attachment: z.unknown().optional(),
});
export type IBackgroundRecord = z.infer<typeof BackgroundRecordSchema>;

// what a tool result records when it moved a command to the background or launched an agent
export const BackgroundResultSchema = z.object({
  backgroundTaskId: TaskIdSchema.optional(),
  isAsync: z.boolean().optional(),
  agentId: TaskIdSchema.optional(),
});

// one content block of a message, as far as background tasks need it
export const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
});

// the input of a TaskStop or KillShell call, which names the task it stops
export const StopInputSchema = z.object({
  task_id: TaskIdSchema.optional(),
  shell_id: TaskIdSchema.optional(),
});

// the status record Claude Code writes for a background task, such as after a compaction
export const TaskStatusSchema = z.object({
  type: z.literal('task_status'),
  taskId: TaskIdSchema,
  status: z.string(),
});

// what one record says about background tasks: those it starts and ends, and stop calls and results
export type IBackgroundEvents = {
  starts: string[];
  ends: string[];
  stopCalls: { toolUseId: string; taskId: string }[];
  results: { toolUseId: string; isSuccess: boolean }[];
};

// a byte budget that reads of several transcripts share, each read taking what it uses
export type IReadBudget = { remaining: number };

// the background tasks of each Claude session, counted from its transcript
export type IClaudeBackgroundTasks = {
  update(
    nativeId: string,
    directory: string,
    startedAt: number | null,
    budget: IReadBudget,
  ): Promise<number>;
  forget(nativeId: string): void;
};
