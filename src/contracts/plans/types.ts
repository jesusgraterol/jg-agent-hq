import { z } from 'zod';

import { ProviderIdSchema } from '../providers/index.js';

// execution revisions are independent of exact file inspection hashes
export const PlanDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanRevisionSchema = z.strictObject({
  planDigest: PlanDigestSchema,
  breakdownDigest: PlanDigestSchema.nullable(),
});
export type IPlanRevision = z.infer<typeof PlanRevisionSchema>;

// JSON-only contract metadata remains safe in the browser contracts entry point.
export const PlanMetadataSchema = z.strictObject({
  scope: z.string().min(1).max(128),
  repositories: z.array(z.string().min(1).max(128)).max(128),
  errorReservations: z
    .array(
      z
        .strictObject({
          repository: z.string().min(1).max(128),
          namespace: z.string().min(1).max(256),
          start: z.number().int().safe(),
          end: z.number().int().safe(),
          registryPath: z.string().min(1).max(4096),
          purpose: z.string().min(1).max(4096),
        })
        .refine((reservation) => reservation.end >= reservation.start),
    )
    .max(128),
  extensions: z.record(z.string(), z.json()).default({}),
});
export type IPlanMetadata = z.infer<typeof PlanMetadataSchema>;
export const PlanTargetSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
});
export type IPlanTarget = z.infer<typeof PlanTargetSchema>;

// provenance describes an explicit operator event, never imported feedback or agent text
export const PlanOperatorActionSchema = z.strictObject({
  id: z.uuid(),
  operatorId: z.string().min(1).max(256),
  source: z.strictObject({
    kind: z.enum(['user-action', 'user-message']),
    reference: z.string().min(1).max(4096),
  }),
});
export type IPlanOperatorAction = z.infer<typeof PlanOperatorActionSchema>;
export const PlanMilestoneSchema = z.object({
  id: z.uuid().nullable(),
  ordinal: z.number().int().positive(),
  title: z.string().min(1).max(4096),
  status: z.enum(['pending', 'in progress', 'done']),
  contractDigest: PlanDigestSchema.nullable(),
});
export type IPlanMilestone = z.infer<typeof PlanMilestoneSchema>;

// actual evidence remains attached to its verified contract through later correspondence
export const PlanCheckSchema = z.strictObject({
  command: z.string().min(1).max(4096),
  outcome: z.literal('passed'),
  reference: z.string().min(1).max(4096),
});
export const PlanCheckoutSchema = z.strictObject({
  repository: z.string().min(1).max(128),
  directory: z.string().min(1).max(4096),
  claimReference: z.string().min(1).max(4096),
  paths: z
    .array(z.string().min(1).max(4096))
    .max(1024)
    .refine((paths) => new Set(paths).size === paths.length),
});
export type IPlanCheckout = z.infer<typeof PlanCheckoutSchema>;
export const PlanWorktreeProofSchema = PlanCheckoutSchema.extend({
  branch: z.string().nullable(),
  head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  fingerprint: PlanDigestSchema,
});
export type IPlanWorktreeProof = z.infer<typeof PlanWorktreeProofSchema>;
export const PlanCompletionSchema = z.strictObject({
  id: z.uuid(),
  action: PlanOperatorActionSchema,
  milestoneId: z.uuid().nullable(),
  revision: PlanRevisionSchema,
  contractDigest: PlanDigestSchema,
  title: z.string().min(1).max(4096),
  contract: z.string().max(1_048_576),
  sharedDigest: PlanDigestSchema.nullable(),
  checkouts: z.array(PlanWorktreeProofSchema).max(128),
  checks: z.array(PlanCheckSchema).min(1).max(32),
  completedAt: z.number().int(),
  reopenActionId: z.uuid().nullable(),
});
export type IPlanCompletion = z.infer<typeof PlanCompletionSchema>;
export const PlanSnapshotMilestoneSchema = PlanMilestoneSchema.extend({
  id: z.uuid(),
  contractDigest: PlanDigestSchema,
  contract: z.string().max(1_048_576),
  sharedDigest: PlanDigestSchema,
});
export type IPlanSnapshotMilestone = z.infer<typeof PlanSnapshotMilestoneSchema>;
export const PlanCheckpointSchema = z.strictObject({
  revision: PlanRevisionSchema,
  plan: z.string().max(1_048_576),
  milestones: z.string().max(1_048_576).nullable(),
  entries: z.array(PlanSnapshotMilestoneSchema).max(1024),
  checkouts: z.array(PlanWorktreeProofSchema).max(128),
  threadIds: z.array(z.uuid()).max(32),
  capturedAt: z.number().int(),
  isQuiescent: z.boolean(),
});
export type IPlanCheckpoint = z.infer<typeof PlanCheckpointSchema>;

// one explicit confirmation covers all unmatched checkpoint entries, including completed work
export const PlanCorrespondenceSchema = z.strictObject({
  sourceIds: z
    .array(z.uuid())
    .min(1)
    .max(1024)
    .refine((ids) => new Set(ids).size === ids.length),
  targetIds: z
    .array(z.uuid())
    .max(1024)
    .refine((ids) => new Set(ids).size === ids.length),
  relation: z.enum(['equivalent', 'requirements-changed', 'omitted', 'reopened']),
  retainedPairs: z.array(z.strictObject({ sourceId: z.uuid(), targetId: z.uuid() })).max(1024),
});
export type IPlanCorrespondence = z.infer<typeof PlanCorrespondenceSchema>;
export const PlanDraftMilestoneSchema = PlanSnapshotMilestoneSchema.extend({
  matchedSourceId: z.uuid().nullable(),
});
export type IPlanDraftMilestone = z.infer<typeof PlanDraftMilestoneSchema>;
export const PlanProposalSchema = z.strictObject({
  id: z.uuid(),
  revision: PlanRevisionSchema,
  inspectionHash: PlanDigestSchema.nullable(),
  drafts: z.array(PlanDraftMilestoneSchema).max(1024),
  unmatchedSourceIds: z.array(z.uuid()).max(1024),
  confirmation: z
    .strictObject({
      action: PlanOperatorActionSchema,
      decisions: z.array(PlanCorrespondenceSchema).max(1024),
    })
    .nullable(),
});
export type IPlanProposal = z.infer<typeof PlanProposalSchema>;
export const PlanRevisionWorkflowSchema = z.strictObject({
  id: z.uuid(),
  action: PlanOperatorActionSchema,
  intent: z.enum(['plan', 'breakdown']),
  phaseActionId: z.uuid(),
  ownerRuntimeEpoch: z.uuid(),
  checkpointActionId: z.uuid(),
  blockActionId: z.uuid(),
  controls: z
    .array(
      z.strictObject({ threadId: z.uuid(), interruptActionId: z.uuid(), closeActionId: z.uuid() }),
    )
    .max(32),
  phase: z.enum([
    'quiescing',
    'editing',
    'reconciling',
    'awaiting-approval',
    'blocked',
    'finished',
  ]),
  reason: z.string().max(4096).nullable(),
  threadIds: z.array(z.uuid()).max(32),
  checkouts: z.array(PlanCheckoutSchema).max(128),
  checkpoint: PlanCheckpointSchema.nullable(),
  invocation: z
    .strictObject({ action: PlanOperatorActionSchema, skill: z.enum(['jg-plan', 'jg-breakdown']) })
    .nullable(),
  proposal: PlanProposalSchema.nullable(),
  createdAt: z.number().int(),
  hasUncertainEffects: z.boolean(),
});
export type IPlanRevisionWorkflow = z.infer<typeof PlanRevisionWorkflowSchema>;
export const PlanCorrespondenceRecordSchema = z.strictObject({
  id: z.uuid(),
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  sources: z.array(PlanSnapshotMilestoneSchema).max(1024),
  targets: z
    .array(
      z.strictObject({
        id: z.uuid(),
        contractDigest: PlanDigestSchema,
        status: PlanMilestoneSchema.shape.status,
      }),
    )
    .max(1024),
  relation: PlanCorrespondenceSchema.shape.relation,
  invalidatedReceiptIds: z.array(z.uuid()).max(1024),
  recordedAt: z.number().int(),
});
export type IPlanCorrespondenceRecord = z.infer<typeof PlanCorrespondenceRecordSchema>;

const MutationFields = {
  target: PlanTargetSchema,
  action: PlanOperatorActionSchema,
  expected: PlanRevisionSchema,
};
export const PlanCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), target: PlanTargetSchema }),
  z.strictObject({
    kind: z.literal('milestones'),
    target: PlanTargetSchema,
    limit: z.number().int().min(1).max(128).default(32),
    cursor: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    kind: z.literal('finalize'),
    ...MutationFields,
    confirmation: z
      .strictObject({
        proposalId: z.uuid(),
        decisions: z.array(PlanCorrespondenceSchema).max(1024),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('complete'),
    ...MutationFields,
    milestoneId: z.uuid().nullable(),
    checks: z.array(PlanCheckSchema).min(1).max(32),
    checkouts: z.array(PlanCheckoutSchema).max(128),
  }),
  z.strictObject({
    kind: z.literal('begin-revision'),
    ...MutationFields,
    intent: z.enum(['plan', 'breakdown']),
    threadIds: z.array(z.uuid()).max(32),
    checkouts: z.array(PlanCheckoutSchema).max(128),
  }),
  z.strictObject({
    kind: z.literal('revision-invoke'),
    ...MutationFields,
    revisionId: z.uuid(),
    skill: z.enum(['jg-plan', 'jg-breakdown']),
  }),
  z.strictObject({
    kind: z.literal('reconciliation'),
    target: PlanTargetSchema,
    collection: z.enum(['sources', 'drafts', 'evidence', 'correspondences']),
    limit: z.number().int().min(1).max(128).default(32),
    cursor: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    kind: z.literal('approve'),
    ...MutationFields,
    scope: z.enum(['plan', 'sequence']),
    presentationHash: PlanDigestSchema,
  }),
  z.strictObject({
    kind: z.literal('revoke'),
    ...MutationFields,
    scope: z.enum(['plan', 'sequence', 'execution', 'all']),
  }),
  z.strictObject({
    kind: z.literal('authorize'),
    ...MutationFields,
    mode: z.enum(['supervised', 'auto']),
    milestoneIds: z
      .array(z.uuid())
      .max(1024)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.strictObject({
    kind: z.literal('check-execution'),
    target: PlanTargetSchema,
    expected: PlanRevisionSchema,
    authorizationId: z.uuid(),
    milestoneId: z.uuid().nullable(),
    mode: z.enum(['supervised', 'auto']),
  }),
]);
export type IPlanCommand = z.infer<typeof PlanCommandSchema>;
export type IPlanCommandInput = z.input<typeof PlanCommandSchema>;

export const PlanApprovalSchema = z.strictObject({
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  presentationHash: PlanDigestSchema,
  createdAt: z.number().int(),
  revokedBy: PlanOperatorActionSchema.nullable(),
});
export const PlanExecutionSchema = z.strictObject({
  runtimeEpoch: z.uuid(),
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  mode: z.enum(['supervised', 'auto']),
  milestoneIds: z.array(z.uuid()).max(1024),
  createdAt: z.number().int(),
  revokedBy: PlanOperatorActionSchema.nullable(),
});
// finalization records identity bookkeeping without granting any approval
export const PlanFinalizationSchema = z.strictObject({
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  fileHash: PlanDigestSchema.nullable(),
  createdAt: z.number().int(),
});
// coordinators own semantic review; the core preserves its exact revision-bound evidence
export const PlanComparisonSchema = z.strictObject({
  sourceRevision: PlanRevisionSchema,
  targetDirectory: z.string().min(1).max(4096),
  targetRevision: PlanRevisionSchema,
  verdict: z.enum(['compatible', 'contradiction']),
  reason: z.string().min(1).max(4096),
  reviewer: z.strictObject({
    provider: ProviderIdSchema,
    cliVersion: z.string().min(1).max(128),
    model: z.string().min(1).max(256).nullable(),
    reference: z.string().min(1).max(4096),
  }),
  reviewedAt: z.number().int().nonnegative(),
});
export type IPlanComparison = z.infer<typeof PlanComparisonSchema>;

export const PlanCoordinationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  comparisons: z.array(PlanComparisonSchema).max(1024),
  finalized: PlanFinalizationSchema.nullable(),
  planApproval: PlanApprovalSchema.nullable(),
  sequenceApproval: PlanApprovalSchema.nullable(),
  execution: PlanExecutionSchema.nullable(),
  lastActionId: z.uuid().nullable(),
  completions: z.array(PlanCompletionSchema).max(1024),
  correspondences: z.array(PlanCorrespondenceRecordSchema).max(1024),
  revision: PlanRevisionWorkflowSchema.nullable(),
  baseline: PlanCheckpointSchema.nullable(),
  observedConflict: z
    .strictObject({
      id: z.uuid(),
      revision: PlanRevisionSchema.nullable(),
      observedAt: z.number().int(),
      ownerRuntimeEpoch: z.uuid(),
      phase: z.enum(['quiescing', 'quiescent', 'blocked']),
      controls: PlanRevisionWorkflowSchema.shape.controls,
    })
    .nullable(),
});
export type IPlanCoordination = z.infer<typeof PlanCoordinationSchema>;

// collection bodies remain in the file owner and paged SQLite projections
export const PlanCoordinationSummarySchema = PlanCoordinationSchema.omit({
  comparisons: true,
  completions: true,
  correspondences: true,
  revision: true,
  baseline: true,
}).extend({
  comparisonCount: z.number().int().nonnegative(),
  completionCount: z.number().int().nonnegative(),
  revision: PlanRevisionWorkflowSchema.omit({
    checkpoint: true,
    proposal: true,
    checkouts: true,
    controls: true,
    checkpointActionId: true,
    blockActionId: true,
  })
    .extend({
      hasCheckpoint: z.boolean(),
      hasProposal: z.boolean(),
      proposalId: z.uuid().nullable(),
      unmatchedCount: z.number().int().nonnegative(),
    })
    .nullable(),
});
export const PlanStatusSchema = z.object({
  directory: z.string(),
  revision: PlanRevisionSchema,
  inspection: z.object({
    plan: PlanDigestSchema,
    milestones: PlanDigestSchema.nullable(),
    coordination: PlanDigestSchema.nullable(),
  }),
  state: z.enum([
    'plan-approval-required',
    'breakdown-required',
    'sequence-approval-required',
    'ready',
    'in-progress',
    'blocked',
    'revising',
    'completed',
  ]),
  pendingActionId: z.uuid().nullable(),
  skillsBinding: z.enum(['absent', 'current', 'stale']),
  isFinalized: z.boolean(),
  isPlanApproved: z.boolean(),
  isSequenceApproved: z.boolean(),
  milestoneCount: z.number().int().min(0).max(1024),
  coordination: PlanCoordinationSummarySchema,
});
export type IPlanStatus = z.infer<typeof PlanStatusSchema>;
// paged retained history omits duplicated source contracts from correspondence summaries
export const PlanCorrespondenceSummarySchema = PlanCorrespondenceRecordSchema.omit({
  sources: true,
}).extend({
  sources: z
    .array(PlanSnapshotMilestoneSchema.pick({ id: true, contractDigest: true, status: true }))
    .max(1024),
});
export const PlanReconciliationEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), entry: PlanSnapshotMilestoneSchema }),
  z.object({ kind: z.literal('draft'), entry: PlanDraftMilestoneSchema }),
  z.object({ kind: z.literal('evidence'), entry: PlanCompletionSchema }),
  z.object({ kind: z.literal('correspondence'), entry: PlanCorrespondenceSummarySchema }),
]);
export type IPlanReconciliationEntry = z.infer<typeof PlanReconciliationEntrySchema>;
export const PlanResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), result: PlanStatusSchema }),
  z.object({ kind: z.literal('reconciliation-required'), result: PlanStatusSchema }),
  z.object({
    kind: z.literal('reconciliation'),
    result: z.object({
      data: z.array(PlanReconciliationEntrySchema).max(128),
      nextCursor: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal('finalized'),
    result: PlanStatusSchema,
    content: z.string().max(1_048_576).nullable(),
  }),
  z.object({
    kind: z.literal('milestones'),
    result: z.object({
      data: z.array(PlanMilestoneSchema).max(128),
      nextCursor: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal('execution-check'),
    result: z.object({ isAuthorized: z.literal(true), authorization: PlanExecutionSchema }),
  }),
]);
export type IPlanResult = z.infer<typeof PlanResultSchema>;
