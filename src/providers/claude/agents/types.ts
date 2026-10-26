import { z } from 'zod';

// one active session; interactive entries report a status and background entries a state
export const ClaudeAgentSchema = z.object({
  sessionId: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  status: z.string().max(64).optional(),
  state: z.string().max(64).optional(),
});
export type IClaudeAgent = z.infer<typeof ClaudeAgentSchema>;
export const ClaudeAgentsSchema = z.array(ClaudeAgentSchema).max(1024);
