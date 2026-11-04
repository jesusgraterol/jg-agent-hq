import { z } from 'zod';
import type { IActionPhase, IProviderId } from '../../contracts/index.js';

/*
 * Only hashes and exact native input identities cross the provenance worker boundary, with the
 * action phase an input's ID names when HQ sent it, as Codex echoes its request IDs.
 */
export type IEvidenceOriginsRequest = {
  provider: IProviderId;
  nativeId: string;
  items: {
    nativeInputId: string | null;
    request: { actionId: string; phase: IActionPhase } | null;
    turnId: string;
    sha256: string | null;
  }[];
};

// a continuation re-reads one bounded native page and verifies its content before advancing
export const EvidencePositionSchema = z.strictObject({
  sourceCursor: z.string().max(12000).nullable(),
  index: z.number().int().min(0).max(8),
  offset: z.number().int().nonnegative(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type IEvidencePosition = z.infer<typeof EvidencePositionSchema>;
