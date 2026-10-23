import { z } from 'zod';

import { ProviderIdSchema } from '../providers/index.js';

// account observations describe native credential configuration, not a network-validity guarantee
export const AccountRequestSchema = z.strictObject({
  kind: z.literal('account'),
  provider: ProviderIdSchema,
});
export type IAccountRequest = z.infer<typeof AccountRequestSchema>;
export const AccountObservationSchema = z.object({
  provider: ProviderIdSchema,
  state: z.enum(['available', 'unavailable']),
  accountType: z.string().max(256).nullable(),
  email: z.string().max(512).nullable(),
  organization: z.string().max(512).nullable(),
  subscription: z.string().max(256).nullable(),
  isAuthenticationRequired: z.boolean().nullable(),
  observedAt: z.number().int().safe().nullable(),
  source: z.literal('native'),
});
export type IAccountObservation = z.infer<typeof AccountObservationSchema>;

// authentication commands retain operator intent; native credentials never cross HQ's API
const AccountControlFields = {
  provider: ProviderIdSchema,
  operatorConfirmation: z.string().trim().min(1).max(1024),
};
export const AccountControlCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account-login'), ...AccountControlFields }),
  z.strictObject({
    kind: z.literal('account-login-cancel'),
    ...AccountControlFields,
    loginActionId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('account-logout'), ...AccountControlFields }),
]);
export type IAccountControlCommand = z.infer<typeof AccountControlCommandSchema>;

// authentication URLs are live presentation, never durable receipt or snapshot content
export const LoginObservationSchema = z.object({
  state: z.enum(['pending', 'completed', 'failed', 'canceled', 'unavailable']),
  authorizationUrl: z
    .string()
    .max(8192)
    .refine((raw) => {
      try {
        const url = new URL(raw);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    })
    .nullable(),
  canCancel: z.boolean(),
  observedAt: z.number().int().safe().nullable(),
});
export type ILoginObservation = z.infer<typeof LoginObservationSchema>;
export const LoginRequestSchema = z.strictObject({ kind: z.literal('login'), actionId: z.uuid() });

// an accepted native challenge is distinct from an applied configuration change
export const NativeControlResultSchema = z.object({
  state: z.enum(['accepted', 'applied', 'held']),
  completion: z.enum(['completed', 'failed', 'interrupted']).nullable(),
});
export type INativeControlResult = z.infer<typeof NativeControlResultSchema>;
