import { z } from 'zod';

import {
  ActionEnvelopeSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ActionPlanContextSchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
} from '../actions/index.js';
import { RuntimeStatusSchema, LiveItemsSchema } from '../types.js';
import { HandoffCommandSchema } from '../handoffs/index.js';
import {
  PlanCommandSchema,
  PlanStatusSchema,
  PlanResultSchema,
  PlanMetadataSchema,
  PlanRevisionSchema,
  PlanTargetSchema,
} from '../plans/index.js';

// the browser surface is closed; hosts resolve every supplied identity against their registry
export const BrowserCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native'), action: ActionEnvelopeSchema }),
  z.strictObject({ kind: z.literal('plan'), command: PlanCommandSchema }),
  z.strictObject({ kind: z.literal('handoff'), command: HandoffCommandSchema }),
  z.strictObject({
    kind: z.literal('priority'),
    target: PlanTargetSchema,
    expectedRevision: PlanRevisionSchema,
    priority: z.enum(['P0', 'P1', 'P2', 'P3']),
    reason: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('error-reservation'),
    target: PlanTargetSchema,
    expectedRevision: PlanRevisionSchema,
    reservation: PlanMetadataSchema.shape.errorReservations.element,
    release: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('publication-retry'),
    expectedCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  }),
]);
export const BrowserActionSchema = z
  .strictObject({
    id: z.uuid(),
    runtimeEpoch: z.uuid(),
    command: BrowserCommandSchema,
  })
  .refine((request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 2_097_152);
export type IBrowserAction = z.infer<typeof BrowserActionSchema>;

// admission and host completion do not imply native turn completion
export const BrowserReceiptSchema = z.object({
  id: z.uuid(),
  runtimeEpoch: z.uuid(),
  kind: z.enum(BrowserCommandSchema.options.map((command) => command.shape.kind.value)),
  state: z.enum(['submitted', 'acknowledged', 'uncertain']),
  nativeActionId: z.uuid(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  native: ActionReceiptSchema.nullable(),
});
export type IBrowserReceipt = z.infer<typeof BrowserReceiptSchema>;

// read models contain generic registration metadata, never deployment configuration
export const BrowserRepositorySchema = z.object({
  name: z.string().max(128),
  root: z.string().max(4096).nullable(),
  purpose: z.string().max(4096),
  worktrees: z.boolean(),
});
export const BrowserPlanSummarySchema = z.object({
  id: z.string().max(128),
  directory: z.string().max(4096),
  scope: z.string().max(128),
  status: z.enum(['planned', 'in-progress', 'done', 'abandoned']),
  summary: z.string().max(4096),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  priorityReason: z.string().max(4096),
  repositories: PlanMetadataSchema.shape.repositories,
  errorReservations: PlanMetadataSchema.shape.errorReservations,
});
export const BrowserPlanPageSchema = z.object({
  data: z.array(BrowserPlanSummarySchema).max(128),
  nextCursor: z.string().nullable(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const BrowserPlanDetailSchema = z.object({
  summary: BrowserPlanSummarySchema,
  contract: z.string().max(1_048_576),
  status: PlanStatusSchema,
  presentation: z.string().max(1_048_576).nullable(),
  page: PlanResultSchema.nullable(),
});
export const BrowserSessionSchema = z.object({
  operator: z.object({ id: z.string().max(256) }),
  runtimeEpoch: z.uuid(),
  capabilities: z.object({
    native: z.boolean(),
    plans: z.boolean(),
    handoffs: z.boolean(),
    priorities: z.boolean(),
    errorReservations: z.boolean(),
    publicationRetry: z.boolean(),
  }),
});

export const BrowserRepositoryPageSchema = z.object({
  data: z.array(BrowserRepositorySchema).max(128),
  nextCursor: z.string().nullable(),
});
export const BrowserSystemSchema = z.object({
  runtime: RuntimeStatusSchema,
  publication: z.object({ state: z.literal('unavailable') }),
  resources: z.object({ state: z.literal('unavailable') }),
  service: z.object({ state: z.literal('unavailable') }),
});
export const BrowserThreadDetailSchema = z.object({
  thread: ManagedThreadSchema,
  plan: ActionPlanContextSchema.nullable(),
  approvals: z.array(NativeApprovalSchema).max(128),
  live: LiveItemsSchema,
  actions: z.object({
    data: z.array(ActionSummarySchema).max(128),
    nextCursor: z.string().nullable(),
  }),
});
