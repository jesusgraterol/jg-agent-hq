import type { INativeLineage } from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

/**
 * Retains confirmed immutable native identities when a later observation leaves them unknown.
 * @returns The combined lineage; unknown fields never erase a confirmed relationship.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const retainNativeLineage = (
  recorded: INativeLineage | null,
  observed: INativeLineage | null,
): INativeLineage | null => {
  if (!recorded) return observed;
  if (!observed) return recorded;
  for (const field of ['sessionId', 'parentThreadId', 'forkedFromId'] as const)
    if (recorded[field] !== null && observed[field] !== null && recorded[field] !== observed[field])
      throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' } });
  return {
    sessionId: observed.sessionId ?? recorded.sessionId,
    parentThreadId: observed.parentThreadId ?? recorded.parentThreadId,
    forkedFromId: observed.forkedFromId ?? recorded.forkedFromId,
  };
};
