import { Exception } from 'jg-exception';
import { z } from 'zod';

import type { IProviderSkills } from '../../types.js';

const CommandsSchema = z.object({
  skills: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\s\p{Cc}]+$/u),
        description: z.string().max(8192),
        argumentHint: z.string().max(4096),
        builtin: z.boolean().optional(),
      }),
    )
    .max(4096),
});

/**
 * Preserves native command precedence and marks metadata absent from Claude's interface unavailable.
 * @returns The currently invocable names, without reading skill bodies or guessing sources.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 */
export const toClaudeSkills = (response: unknown): Omit<IProviderSkills, 'observedAt'> => {
  const parsed = CommandsSchema.safeParse(response);
  if (!parsed.success)
    throw new Exception('The Claude integration failed', {
      code: 'JG_AGENT_HQ_CLAUDE_FAILED',
      data: { kind: 'agent-unavailable' },
      cause: parsed.error,
    });
  const commands = new Map<string, z.infer<typeof CommandsSchema>['skills'][number]>();
  for (const command of parsed.data.skills) {
    const existing = commands.get(command.name);
    if (existing && Boolean(existing.builtin) === Boolean(command.builtin))
      throw new Exception('The Claude integration failed', {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: {
          kind: 'agent-unavailable',
        },
      });
    if (!existing || command.builtin) commands.set(command.name, command);
  }
  return {
    unavailableCount: 0,
    skills: [...commands.values()].map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      kind: command.builtin ? 'command' : 'unavailable',
      path: null,
      scope: null,
      isEnabled: true,
      requiresExplicitInvocation: null,
      prerequisites: null,
    })),
  };
};
