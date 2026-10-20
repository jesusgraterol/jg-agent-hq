import { z } from 'zod';

// execution revisions are independent of exact file inspection hashes
export const PlanDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanRevisionSchema = z.strictObject({
  planDigest: PlanDigestSchema,
  breakdownDigest: PlanDigestSchema.nullable(),
});
export type IPlanRevision = z.infer<typeof PlanRevisionSchema>;

// private coordinators supply parsed frontmatter boundaries and contract metadata
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
});
export type IPlanMetadata = z.infer<typeof PlanMetadataSchema>;
export const PlanTargetSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  context: z
    .strictObject({
      bodyStart: z.number().int().min(0).max(1_048_576),
      metadata: PlanMetadataSchema,
    })
    .optional(),
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
  z.strictObject({ kind: z.literal('finalize'), ...MutationFields }),
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
      .min(1)
      .max(1024)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.strictObject({
    kind: z.literal('check-execution'),
    target: PlanTargetSchema,
    expected: PlanRevisionSchema,
    authorizationId: z.uuid(),
    milestoneId: z.uuid(),
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
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  mode: z.enum(['supervised', 'auto']),
  milestoneIds: z.array(z.uuid()).min(1).max(1024),
  createdAt: z.number().int(),
  revokedBy: PlanOperatorActionSchema.nullable(),
});
// finalization records identity bookkeeping without granting any approval
export const PlanFinalizationSchema = z.strictObject({
  action: PlanOperatorActionSchema,
  revision: PlanRevisionSchema,
  fileHash: PlanDigestSchema,
  createdAt: z.number().int(),
});
export const PlanCoordinationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  finalized: PlanFinalizationSchema.nullable(),
  planApproval: PlanApprovalSchema.nullable(),
  sequenceApproval: PlanApprovalSchema.nullable(),
  execution: PlanExecutionSchema.nullable(),
  lastActionId: z.uuid().nullable(),
});
export type IPlanCoordination = z.infer<typeof PlanCoordinationSchema>;

export const PlanMilestoneSchema = z.object({
  id: z.uuid().nullable(),
  ordinal: z.number().int().positive(),
  title: z.string().min(1).max(4096),
  status: z.enum(['pending', 'in progress', 'done']),
  contractDigest: PlanDigestSchema.nullable(),
});
export type IPlanMilestone = z.infer<typeof PlanMilestoneSchema>;
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
  ]),
  pendingActionId: z.uuid().nullable(),
  isFinalized: z.boolean(),
  isPlanApproved: z.boolean(),
  isSequenceApproved: z.boolean(),
  milestoneCount: z.number().int().min(0).max(1024),
  coordination: PlanCoordinationSchema,
});
export type IPlanStatus = z.infer<typeof PlanStatusSchema>;
export const PlanResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), result: PlanStatusSchema }),
  z.object({
    kind: z.literal('finalized'),
    result: PlanStatusSchema,
    content: z.string().max(1_048_576),
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
