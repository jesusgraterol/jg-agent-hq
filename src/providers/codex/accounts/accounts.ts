import { z } from 'zod';

import { AccountObservationSchema, type IAccountObservation } from '../../../contracts/index.js';
import type { createCodexRpc } from '../rpc.js';

const AccountSchema = z.object({
  account: z
    .object({
      type: z.string().min(1).max(256),
      email: z.string().max(512).nullish(),
      planType: z.string().max(256).nullish(),
    })
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

/**
 * Uses the native account observation without reading or returning credential storage.
 * @returns Account metadata whose unavailable state cannot disable session controls.
 */
export const createCodexAccounts = (connection: Awaited<ReturnType<typeof createCodexRpc>>) => ({
  /** @returns Current native account configuration, without triggering token refresh. */
  async readAccount(): Promise<IAccountObservation> {
    try {
      const native = AccountSchema.parse(
        await connection.request('account/read', { refreshToken: false }),
      );
      return AccountObservationSchema.parse({
        provider: 'codex',
        state: 'available',
        accountType: native.account?.type ?? null,
        email: native.account?.email ?? null,
        organization: null,
        subscription: native.account?.planType ?? null,
        isAuthenticationRequired: native.requiresOpenaiAuth,
        observedAt: Date.now(),
        source: 'native',
      });
    } catch {
      return {
        provider: 'codex',
        state: 'unavailable',
        accountType: null,
        email: null,
        organization: null,
        subscription: null,
        isAuthenticationRequired: null,
        observedAt: null,
        source: 'native',
      };
    }
  },
});
