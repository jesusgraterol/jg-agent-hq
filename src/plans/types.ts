import { z } from 'zod';

import {
  PlanCoordinationSchema,
  PlanDigestSchema,
  PlanMilestoneSchema,
  PlanRevisionSchema,
  type IPlanMetadata,
  type IPlanMilestone,
  type IPlanRevision,
} from '../contracts/index.js';

// full bounded artifacts are used only for the selected plan, never a repository scan
export type IParsedMilestone = IPlanMilestone & {
  headingStart: number;
  statusEnd: number;
  contract: string;
  sharedDigest: string;
};
export type IPlanArtifacts = {
  directory: string;
  plan: string;
  milestones: string | null;
  coordinationText: string | null;
  coordination: z.infer<typeof PlanCoordinationSchema>;
  parsed: IParsedMilestone[];
  revision: IPlanRevision;
  hashes: { plan: string; milestones: string | null; coordination: string | null };
};
export type IPlanContract = { body: string; metadata: IPlanMetadata; milestones: string | null };

// persisted intents make an interrupted finalization retry reuse its assigned UUIDs
export const PlanWriteIntentSchema = z.strictObject({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  directory: z.string(),
  before: z.strictObject({
    plan: z.string(),
    milestones: z.string().nullable(),
    coordination: z.string().nullable(),
  }),
  coordination: z.string().max(1_048_576),
  milestones: z.string().max(1_048_576).nullable(),
  state: z.enum(['prepared', 'completed']),
});
export type IPlanWriteIntent = z.infer<typeof PlanWriteIntentSchema>;
export const PlanProjectionSchema = z.strictObject({
  directory: z.string(),
  sourceHash: PlanDigestSchema.nullable(),
  milestones: z.array(PlanMilestoneSchema).max(1024),
});
export type IPlanProjection = z.infer<typeof PlanProjectionSchema>;
export const PlanMilestonePositionSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  inspection: PlanDigestSchema.nullable(),
  revision: PlanRevisionSchema,
});
export const PlanProjectionPageSchema = z.strictObject({
  directory: z.string(),
  limit: z.number().int().min(1).max(128),
  after: z.number().int().nonnegative(),
});
export const PlanProjectionResultSchema = z.object({
  data: z.array(PlanMilestoneSchema).max(128),
  hasMore: z.boolean(),
});
