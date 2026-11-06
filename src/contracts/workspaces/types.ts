import { z } from 'zod';

// a workspace change remains bound to the exact source the caller observed
export const WorkspaceChangeSchema = z.strictObject({
  expectedWorkspaceRoot: z.string().min(1).max(4096),
  workspaceRoot: z.string().min(1).max(4096),
});
export type IWorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;

// selected receipts expose bounded transition evidence without queued input bodies
export const WorkspaceTransitionSchema = z.object({
  actionId: z.uuid(),
  threadId: z.uuid(),
  sourceWorkspaceRoot: z.string(),
  targetWorkspaceRoot: z.string(),
  historyWorkspaceRoot: z.string().nullable(),
  state: z.enum(['prepared', 'submitted', 'confirmed', 'failed', 'uncertain']),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type IWorkspaceTransition = z.infer<typeof WorkspaceTransitionSchema>;
