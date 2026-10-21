import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

/**
 * Validates native input and normalized output at the adapter boundary.
 * @returns The validated contract.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const parseNative = <T>(schema: z.ZodType<T>, response: unknown): T => {
  const parsed = schema.safeParse(response);
  if (!parsed.success)
    throw new Exception(`The Codex integration failed: ${extractMessage(parsed.error)}`, {
      code: 'JG_AGENT_HQ_CODEX_FAILED',
      data: { kind: 'agent-unavailable' },
      cause: parsed.error,
    });
  return parsed.data;
};
