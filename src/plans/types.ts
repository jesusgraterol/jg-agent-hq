import { z } from 'zod';

import {
  PlanCoordinationSchema,
  PlanDigestSchema,
  PlanMilestoneSchema,
  PlanRevisionSchema,
  PlanReconciliationEntrySchema,
  type IActionEnvelope,
  type IPlanMetadata,
  type IPlanStatus,
  type IPlanMilestone,
  type IPlanRevision,
  type IPlanRevisionWorkflow,
} from '../contracts/index.js';

// full bounded artifacts are used only for the selected plan, never a repository scan
export type IParsedMilestone = IPlanMilestone & {
  contract: string;
  sharedDigest: string;
};
export type IPlanArtifacts = {
  directory: string;
  contract: { body: string; metadata: IPlanMetadata };
  plan: string;
  milestones: string | null;
  coordinationText: string | null;
  skillsBinding: IPlanStatus['skillsBinding'];
  coordination: z.infer<typeof PlanCoordinationSchema>;
  parsed: IParsedMilestone[];
  revision: IPlanRevision;
  hashes: { plan: string; milestones: string | null; coordination: string | null };
  conformance: IPlanConformance;
};
export type IPlanContract = { body: string; metadata: IPlanMetadata; milestones: string | null };

// jg-plans check results for the stages HQ gates; plans without protocol 0.2 always conform
export type IPlanConformance = { plan: boolean; sequence: boolean };

// persisted intents make an interrupted finalization retry reuse its assigned UUIDs
export const PlanWriteIntentSchema = z
  .strictObject({
    id: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    directory: z.string(),
    before: z.strictObject({
      plan: z.string().nullable(),
      milestones: z.string().nullable(),
      coordination: z.string().nullable(),
    }),
    coordination: z.string().max(8_388_608),
    plan: z.string().max(1_048_576).nullable(),
    milestones: z.discriminatedUnion('operation', [
      z.strictObject({ operation: z.literal('keep') }),
      z.strictObject({ operation: z.literal('write'), source: z.string().max(1_048_576) }),
      z.strictObject({ operation: z.literal('remove') }),
    ]),
    state: z.enum(['prepared', 'completed']),
  })
  .refine(
    (intent) =>
      intent.before.plan !== null ||
      (intent.plan === null && intent.milestones.operation === 'keep'),
  );
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

// the private host owns its frontmatter policy; the core supplies exact current file contents
export type IPlanContractParser = (input: {
  directory: string;
  content: string;
}) =>
  | { body: string; metadata: IPlanMetadata }
  | Promise<{ body: string; metadata: IPlanMetadata }>;

// a selected coordination file supplies replaceable, bounded seek projections
export const PlanRevisionProjectionSchema = z.strictObject({
  directory: z.string(),
  sourceHash: PlanDigestSchema.nullable(),
  records: z
    .array(
      z.strictObject({
        collection: z.enum(['sources', 'drafts', 'evidence', 'correspondences']),
        id: z.string().min(1).max(128),
        entry: PlanReconciliationEntrySchema,
      }),
    )
    .max(65_536),
});
export type IPlanRevisionProjection = z.infer<typeof PlanRevisionProjectionSchema>;
export const PlanRevisionPageSchema = z.strictObject({
  directory: z.string(),
  collection: z.enum(['sources', 'drafts', 'evidence', 'correspondences']),
  after: z.string().max(128),
  limit: z.number().int().min(1).max(128),
});
export const PlanRevisionPageResultSchema = z.object({
  data: z.array(PlanReconciliationEntrySchema).max(128),
  lastId: z.string().nullable(),
  hasMore: z.boolean(),
});

// continuations bind every inspected coordination revision and selected collection
export const PlanRevisionPositionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  inspection: PlanDigestSchema.nullable(),
});

// one owned stop phase, without an agent execution loop or client-supplied quiescence evidence
export type IPlanStopJob = {
  kind: 'revision' | 'observation' | 'invalid-artifact';
  directory: string;
  revisionId: string;
  phaseActionId: string;
  controls: IPlanRevisionWorkflow['controls'];
};

// The caller owns the HQ metadata lock; this callback owns only bounded document work.
export type IApplyPlanIntent = (intent: IPlanWriteIntent) => Promise<void>;
export type IWithPlanDocuments = <T>(
  directory: string,
  operation: (apply: IApplyPlanIntent) => Promise<T>,
) => Promise<T>;

export type IPrepareImplementation = (
  artifacts: IPlanArtifacts,
  action: IActionEnvelope,
  milestoneId: string | null,
  apply: IApplyPlanIntent,
) => Promise<void>;
export type IResumeImplementation = (directory: string, action: IActionEnvelope) => Promise<void>;
