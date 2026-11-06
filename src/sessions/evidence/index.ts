// bounded native evidence selection
export {
  buildEvidencePage,
  evidencePosition,
  evidenceHash,
  nativeProvenance,
  resetProvenance,
  EVIDENCE_RESPONSE_BYTES,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from './utilities.js';
// private worker provenance lookup
export type { IEvidenceOriginsRequest } from './types.js';

// verified history and live input origins
export { correlateEvidenceOrigins } from './origins.js';
