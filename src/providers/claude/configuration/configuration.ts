import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import type {
  IConfigurationRequest,
  ISessionConfiguration,
  ISessionSettings,
} from '../../../contracts/index.js';
import { pageConfigurationChoices } from '../../configuration/index.js';
import { capabilityUnavailable } from '../../registry/index.js';

const SelectionSchema = z.string().min(1).max(4096).nullable().optional();
const SettingsSchema = z.object({
  effective: z.object({
    model: SelectionSchema,
    effortLevel: SelectionSchema,
    agent: SelectionSchema,
  }),
  applied: z.object({ model: SelectionSchema, effort: SelectionSchema }).optional(),
});
const AgentsSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(256),
      description: z.string().max(8192).optional(),
      model: SelectionSchema,
    }),
  )
  .max(4096)
  .refine((agents) => new Set(agents.map((agent) => agent.name)).size === agents.length);

/**
 * Selects documented native startup flags while retaining native settings and authentication.
 * @returns Typed flag arguments, never a settings document or global config mutation.
 * @throws
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 */
export const toClaudeSessionFlags = (settings: ISessionSettings): string[] => {
  if (settings.sandbox !== undefined) capabilityUnavailable();
  return [
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.effort ? ['--effort', settings.effort] : []),
    ...(settings.nativeAgent ? ['--agent', settings.nativeAgent] : []),
    ...(settings.permissionMode ? ['--permission-mode', settings.permissionMode] : []),
    ...(settings.systemInstructions !== undefined
      ? ['--system-prompt', settings.systemInstructions]
      : []),
    ...(settings.developerInstructions !== undefined
      ? ['--append-system-prompt', settings.developerInstructions]
      : []),
  ];
};

/**
 * Reads known native settings without exposing sources, hooks, tokens or arbitrary configuration.
 * @returns Effective session settings and a bounded, query-bound native agent page.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const toClaudeConfiguration = (
  input: unknown,
  agentsInput: unknown,
  permissionMode: unknown,
  nativeId: string | undefined,
  settings: ISessionSettings,
  command: IConfigurationRequest,
): ISessionConfiguration => {
  const parsed = SettingsSchema.safeParse(input);
  const agents = AgentsSchema.safeParse(agentsInput);
  if (!parsed.success)
    throw new Exception(`The Claude integration failed: ${extractMessage(parsed.error)}`, {
      code: 'JG_AGENT_HQ_CLAUDE_FAILED',
      data: { kind: 'agent-unavailable' },
      cause: parsed.error,
    });
  const page = pageConfigurationChoices(
    agents.success
      ? agents.data.map((agent) => ({
          kind: 'agent' as const,
          id: agent.name,
          description: agent.description?.slice(0, 256) ?? null,
          model: agent.model ?? null,
        }))
      : [],
    command,
  );
  const value = parsed.data;
  return {
    provider: 'claude',
    nativeId: nativeId ?? null,
    workingDirectory: command.workspaceRoot,
    effective: {
      model:
        value.applied?.model !== undefined ? value.applied.model : (value.effective.model ?? null),
      effort:
        value.applied?.effort !== undefined
          ? value.applied.effort
          : (value.effective.effortLevel ?? null),
      nativeAgent:
        value.effective.agent !== undefined
          ? value.effective.agent
          : (settings.nativeAgent ?? null),
      nativeProfile: null,
      permissionMode: typeof permissionMode === 'string' ? permissionMode : null,
      sandbox: null,
      systemInstructions: nativeId ? (settings.systemInstructions ?? null) : null,
      developerInstructions: nativeId ? (settings.developerInstructions ?? null) : null,
    },
    instructionSources: { data: [], isComplete: false },
    choices: agents.success ? page.choices : null,
    nextCursor: page.nextCursor,
    source: 'native',
    observedAt: Date.now(),
  };
};
