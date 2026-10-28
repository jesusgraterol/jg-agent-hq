import { z } from 'zod';

// one active session; interactive entries report a status and background entries a state
export const ClaudeAgentSchema = z.object({
  // the short ID `claude attach` takes, which only background sessions report
  id: z.string().min(1).max(64).optional(),
  kind: z.string().max(64).optional(),
  sessionId: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  // present only while the session's process runs
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  status: z.string().max(64).optional(),
  state: z.string().max(64).optional(),
});
export type IClaudeAgent = z.infer<typeof ClaudeAgentSchema>;
export const ClaudeAgentsSchema = z.array(ClaudeAgentSchema).max(1024);
