import type { IEvidenceItem, IHistoryItem, IProviderId } from '../../contracts/index.js';
import { parseActionRequest } from '../../providers/index.js';
import type { IStore } from '../../store/index.js';

import { resetProvenance } from './utilities.js';

// native history fragments and live rows share the same exact input correlation boundary
type IProvenanceItem = Pick<IHistoryItem, 'kind' | 'provenance'> &
  (Pick<IHistoryItem, 'turnId'> | Pick<IEvidenceItem, 'reference'>);

/**
 * Replaces provider assertions with provenance verified against acknowledged native inputs.
 * Only input identities and hashes cross the worker boundary; message bodies stay in their owner.
 * @param items Fresh presentation rows, including full-input fingerprints before preview cuts.
 * @param provider The provider whose native session supplied the rows.
 * @param nativeId The selected native session.
 * @param store The authoritative action ledger.
 * @mutates Replaces provenance on the supplied presentation rows.
 * @returns Completion after the eligible user inputs have been correlated.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const correlateEvidenceOrigins = async (
  items: IProvenanceItem[],
  provider: IProviderId,
  nativeId: string,
  store: IStore,
): Promise<void> => {
  for (const item of items) item.provenance = resetProvenance(item.kind, item.provenance);
  const inputs = items.filter(
    ({ kind, provenance }) =>
      kind === 'user-message' &&
      provenance.nativeInputId !== null &&
      provenance.nativeInputSha256 !== null,
  );
  if (inputs.length === 0) return;
  const origins = await store.call('reads', 'getEvidenceOrigins', {
    provider,
    nativeId,
    items: inputs.map(({ provenance, ...item }) => ({
      nativeInputId: provenance.nativeInputId,
      request: parseActionRequest(provenance.nativeInputId!),
      turnId: 'reference' in item ? item.reference.turnId : item.turnId,
      sha256: provenance.nativeInputSha256,
    })),
  });
  for (const [index, origin] of origins.entries()) if (origin) inputs[index]!.provenance = origin;
};
