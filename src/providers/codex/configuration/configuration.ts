import { z } from 'zod';

import type {
  IConfigurationRequest,
  ISessionSettings,
  ISessionConfiguration,
} from '../../../contracts/index.js';
import { pageConfigurationChoices } from '../../configuration/index.js';
import { capabilityUnavailable } from '../../registry/index.js';
import { parseNative } from '../validations.js';

const SelectionSchema = z.string().min(1).max(4096).nullable().optional();
const InstructionsSchema = z.string().max(8192).nullable().optional();
const EntrySchema = z.object({
  model: SelectionSchema,
  description: z.string().max(8192).optional(),
});
const ConfigSchema = z.object({
  config: z.object({
    model: SelectionSchema,
    model_reasoning_effort: SelectionSchema,
    profile: SelectionSchema,
    approval_policy: z.unknown().optional(),
    sandbox_mode: SelectionSchema,
    instructions: InstructionsSchema,
    developer_instructions: InstructionsSchema,
    profiles: z.record(z.string().min(1).max(256), EntrySchema).nullish(),
    agents: z.record(z.string().min(1).max(256), z.unknown()).nullish(),
  }),
});
const SessionSchema = z.object({
  thread: z.object({
    id: z.string(),
    cwd: z.string(),
    model: SelectionSchema,
    reasoningEffort: SelectionSchema,
  }),
  model: SelectionSchema,
  reasoningEffort: SelectionSchema,
  approvalPolicy: z.unknown().optional(),
  sandbox: z.object({ type: z.string().max(256) }).optional(),
  instructionSources: z.array(z.string().max(4096)).max(4096).optional(),
});

/**
 * Retains only configuration fields returned by a native session acknowledgement.
 * @returns Known bounded configuration metadata, or null when optional metadata is unavailable.
 */
export const readCodexConfigurationObservation = (input: unknown) => {
  const parsed = SessionSchema.safeParse(input);
  return parsed.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= 1_048_576
    ? parsed.data
    : null;
};

/**
 * Maps explicit creation settings to supported native parameters without changing config files.
 * @returns The selected native overrides; omitted settings retain native defaults.
 * @throws
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 */
export const toCodexSessionSettings = (settings: ISessionSettings) => {
  if (settings.nativeAgent !== undefined) capabilityUnavailable();
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
    ...(settings.permissionMode ? { approvalPolicy: settings.permissionMode } : {}),
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    ...(settings.systemInstructions !== undefined
      ? { baseInstructions: settings.systemInstructions }
      : {}),
    ...(settings.developerInstructions !== undefined
      ? { developerInstructions: settings.developerInstructions }
      : {}),
  };
};

/**
 * Projects only known effective settings and bounded native profile/agent metadata.
 * @returns A configuration page, with unknown session settings left null.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const toCodexConfiguration = (
  input: unknown,
  sessionInput: unknown | undefined,
  settings: ISessionSettings,
  command: IConfigurationRequest,
): ISessionConfiguration => {
  const { config } = parseNative(ConfigSchema, input);
  const session = sessionInput === undefined ? undefined : parseNative(SessionSchema, sessionInput);
  const choices = [
    ...Object.entries(config.profiles ?? {}).map(([id, entry]) => ({
      kind: 'profile' as const,
      id,
      model: entry.model ?? null,
      description: entry.description?.slice(0, 256) ?? null,
    })),
    ...Object.entries(config.agents ?? {}).flatMap(([id, input]) => {
      const entry = EntrySchema.safeParse(input);
      return entry.success
        ? [
            {
              kind: 'agent' as const,
              id,
              model: entry.data.model ?? null,
              description: entry.data.description?.slice(0, 256) ?? null,
            },
          ]
        : [];
    }),
  ];
  if (choices.length > 4096) parseNative(z.never(), input);
  const policy = session ? session.approvalPolicy : config.approval_policy;
  return {
    provider: 'codex',
    nativeId: session?.thread.id ?? null,
    workingDirectory: session?.thread.cwd ?? command.workspaceRoot,
    effective: {
      model: session
        ? session.thread.model !== undefined
          ? session.thread.model
          : (session.model ?? null)
        : (config.model ?? null),
      effort: session
        ? session.thread.reasoningEffort !== undefined
          ? session.thread.reasoningEffort
          : (session.reasoningEffort ?? null)
        : (config.model_reasoning_effort ?? null),
      nativeAgent: null,
      nativeProfile: session ? null : (config.profile ?? null),
      permissionMode: typeof policy === 'string' ? policy : null,
      sandbox: session ? (session.sandbox?.type ?? null) : (config.sandbox_mode ?? null),
      systemInstructions: session
        ? (settings.systemInstructions ?? null)
        : (config.instructions ?? null),
      developerInstructions: session
        ? (settings.developerInstructions ?? null)
        : (config.developer_instructions ?? null),
    },
    instructionSources: {
      data: session?.instructionSources?.slice(0, 128) ?? [],
      isComplete:
        session?.instructionSources !== undefined && session.instructionSources.length <= 128,
    },
    ...pageConfigurationChoices(choices, command),
    source: 'native',
    observedAt: Date.now(),
  };
};
