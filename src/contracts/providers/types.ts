import { z } from 'zod';

// registry capacity also bounds status payloads and trusted construction input
export const MAX_PROVIDERS = 32;

// provider identity is independent of the installed native executable's version
export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export type IProviderId = z.infer<typeof ProviderIdSchema>;

// public reasons contain stable classifications and safe explanations
export const CapabilityReasonSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
});
export const ProviderCapabilitySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('supported'),
    changeMode: z.enum(['live', 'idle-restart']),
    reason: z.null(),
  }),
  z.object({
    state: z.enum(['unsupported', 'unavailable', 'unknown']),
    changeMode: z.null(),
    reason: CapabilityReasonSchema,
  }),
]);
export type IProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

// these are the concrete operations implemented by the current HQ control surface
export const ProviderCapabilitySetSchema = z.object({
  operations: z.object({
    create: ProviderCapabilitySchema,
    adopt: ProviderCapabilitySchema,
    resume: ProviderCapabilitySchema,
    rename: ProviderCapabilitySchema,
    close: ProviderCapabilitySchema,
    interrupt: ProviderCapabilitySchema,
    recover: ProviderCapabilitySchema,
    steer: ProviderCapabilitySchema,
    history: ProviderCapabilitySchema,
    usage: ProviderCapabilitySchema,
    skills: ProviderCapabilitySchema,
    models: ProviderCapabilitySchema,
    fork: ProviderCapabilitySchema,
    archive: ProviderCapabilitySchema,
    unarchive: ProviderCapabilitySchema,
    compact: ProviderCapabilitySchema,
    revert: ProviderCapabilitySchema,
    configuration: ProviderCapabilitySchema,
  }),
  inputSchema: z.record(z.string(), z.json()).nullable(),
  configurationSchema: z.record(z.string(), z.json()).nullable(),
});
export type IProviderCapabilitySet = z.infer<typeof ProviderCapabilitySetSchema>;

export const ProviderCapabilitiesSchema = ProviderCapabilitySetSchema.extend({
  provider: ProviderIdSchema,
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('provider') }),
    z.object({ kind: z.literal('session'), threadId: z.uuid() }),
  ]),
  observedAt: z.number().int().safe(),
});
export type IProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// status reads report lazy connection state without starting a native process
export const ProviderStatusSchema = z.object({
  provider: ProviderIdSchema,
  state: z.enum(['idle', 'ready', 'unavailable']),
  version: z.string().max(4096).nullable(),
});
export type IProviderStatus = z.infer<typeof ProviderStatusSchema>;
