import { z } from 'zod';

import { AccountObservationSchema, type IAccountObservation } from '../../../contracts/index.js';

const AccountSchema = z.object({
  email: z.string().max(512).nullish(),
  organization: z.string().max(512).nullish(),
  subscriptionType: z.string().max(256).nullish(),
  apiProvider: z.string().max(256).nullish(),
  tokenSource: z.string().max(256).nullish(),
  apiKeySource: z.string().max(256).nullish(),
});

/**
 * Selects only documented account metadata from native initialization.
 * @returns A safe account observation, without treating missing fields as proof of sign-out.
 */
export const toClaudeAccount = (raw: unknown, observedAt: number): IAccountObservation => {
  const parsed = AccountSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0)
    return {
      provider: 'claude',
      state: 'unavailable',
      accountType: null,
      email: null,
      organization: null,
      subscription: null,
      isAuthenticationRequired: null,
      observedAt: null,
      source: 'native',
    };
  const account = parsed.data;
  return AccountObservationSchema.parse({
    provider: 'claude',
    state: 'available',
    accountType: account.apiProvider ?? null,
    email: account.email ?? null,
    organization: account.organization ?? null,
    subscription: account.subscriptionType ?? null,
    isAuthenticationRequired: null,
    observedAt,
    source: 'native',
  });
};
