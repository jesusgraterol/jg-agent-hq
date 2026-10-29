import { z } from 'zod';
import { ProviderIdSchema } from '../../contracts/index.js';

// only hashes and exact native input identities cross the provenance worker boundary
export const EvidenceOriginsRequestSchema = z.strictObject({
  provider: ProviderIdSchema,
  nativeId: z.string().min(1).max(4096),
  items: z
    .array(
      z.strictObject({
        nativeInputId: z.string().min(1).max(4096).nullable(),
        turnId: z.string().min(1).max(4096),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    )
    .max(128),
});
export type IEvidenceOriginsRequest = z.infer<typeof EvidenceOriginsRequestSchema>;

// a continuation re-reads one bounded native page and verifies its content before advancing
export const EvidencePositionSchema = z.strictObject({
  sourceCursor: z.string().max(12000).optional(),
  index: z.number().int().min(0).max(8),
  offset: z.number().int().nonnegative(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type IEvidencePosition = z.infer<typeof EvidencePositionSchema>;
