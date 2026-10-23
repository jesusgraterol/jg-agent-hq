import type { IAccountObservation, IAccountRequest } from '../contracts/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';

/**
 * Coalesces native account observations without reading credentials or retaining a stale cache.
 * @returns Account reads isolated from unrelated native session controls.
 */
export const createAccounts = (registry: ReturnType<typeof createProviderRegistry>) => {
  const pending = new Map<string, Promise<IAccountObservation>>();
  return {
    /** Stops new reads joining an observation started before a native change. */
    invalidate(): void {
      pending.clear();
    },
    /**
     * Reads the selected provider's safe native account metadata.
     * @returns The current native observation, including an explicit unavailable state.
     * @throws
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     */
    async read(command: IAccountRequest): Promise<IAccountObservation> {
      let operation = pending.get(command.provider);
      if (!operation) {
        operation = (async () => (await registry.get(command.provider)).readAccount())();
        pending.set(command.provider, operation);
      }
      try {
        return await operation;
      } finally {
        if (pending.get(command.provider) === operation) pending.delete(command.provider);
      }
    },
  };
};
