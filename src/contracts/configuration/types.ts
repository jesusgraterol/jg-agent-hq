import { z } from 'zod';

import { CursorSchema, NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';

// native model and effort names are discovered rather than fixed to a vendor release
const SelectionSchema = z.string().min(1).max(256);
export const TurnSettingsSchema = z.strictObject({
  model: NativeIdSchema.optional(),
  effort: z.string().min(1).max(64).optional(),
});
export type ITurnSettings = z.infer<typeof TurnSettingsSchema>;
export const SessionSettingsSchema = TurnSettingsSchema.extend({
  nativeAgent: SelectionSchema.optional(),
  permissionMode: SelectionSchema.optional(),
  sandbox: SelectionSchema.optional(),
  systemInstructions: z.string().max(8192).optional(),
  developerInstructions: z.string().max(8192).optional(),
});
export type ISessionSettings = z.infer<typeof SessionSettingsSchema>;

// settings reads expose only explicit fields, never the native configuration document or credentials
export const ConfigurationChoiceSchema = z.object({
  kind: z.enum(['agent', 'profile']),
  id: SelectionSchema,
  description: z.string().max(256).nullable(),
  model: NativeIdSchema.nullable(),
});
export type IConfigurationChoice = z.infer<typeof ConfigurationChoiceSchema>;
export const ConfigurationRequestSchema = z.strictObject({
  kind: z.literal('configuration'),
  provider: ProviderIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  threadId: z.uuid().optional(),
  limit: z.number().int().min(1).max(128).default(32),
  cursor: CursorSchema.optional(),
});
export type IConfigurationRequest = z.infer<typeof ConfigurationRequestSchema>;
export const SessionConfigurationSchema = z.object({
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema.nullable(),
  workingDirectory: z.string().max(4096),
  effective: z.object({
    model: NativeIdSchema.nullable(),
    effort: z.string().min(1).max(64).nullable(),
    nativeAgent: SelectionSchema.nullable(),
    nativeProfile: SelectionSchema.nullable(),
    permissionMode: SelectionSchema.nullable(),
    sandbox: SelectionSchema.nullable(),
    systemInstructions: z.string().max(8192).nullable(),
    developerInstructions: z.string().max(8192).nullable(),
  }),
  instructionSources: z.object({
    data: z.array(z.string().max(4096)).max(128),
    isComplete: z.boolean(),
  }),
  choices: z.array(ConfigurationChoiceSchema).max(128).nullable(),
  nextCursor: CursorSchema.nullable(),
  observedAt: z.number().int().safe(),
  source: z.literal('native'),
});
export type ISessionConfiguration = z.infer<typeof SessionConfigurationSchema>;
