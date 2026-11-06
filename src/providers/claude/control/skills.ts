import { z } from 'zod';

import type { IProviderSkills } from '../../types.js';
import { HQ_ERRORS } from '../../../errors/index.js';

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
    throw HQ_ERRORS.create('claudeFailed', {
      data: { kind: 'agent-unavailable' },
      cause: parsed.error,
    });
  const commands = new Map<string, z.infer<typeof CommandsSchema>['skills'][number]>();
  for (const command of parsed.data.skills) {
    const existing = commands.get(command.name);
    if (existing && Boolean(existing.builtin) === Boolean(command.builtin))
      throw HQ_ERRORS.create('claudeFailed', {
        data: { kind: 'agent-unavailable' },
      });
    if (!existing || command.builtin) commands.set(command.name, command);
  }
  return {
    invocationPrefix: '/',
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

/**
 * Captures a bounded native catalog; unsupported optional metadata leaves it unavailable.
 * @returns The captured catalog, or null when native metadata cannot support it.
 */
export const captureClaudeSkills = (
  commands: unknown,
  observedAt: number,
): IProviderSkills | null => {
  try {
    const skills = toClaudeSkills({ skills: commands });
    return Buffer.byteLength(JSON.stringify(skills.skills)) <= 1_048_576
      ? { ...skills, observedAt }
      : null;
  } catch {
    return null;
  }
};
