import { z } from 'zod';

import { ProviderIdSchema } from '../providers/index.js';

import { ActionPlanContextSchema, ActionReceiptSchema } from '../actions/index.js';
import { NativeIdSchema } from '../identities/index.js';

// handoffs retain exact native identities; names are presentation only
export const HandoffSourceSchema = z.object({
  threadId: z.uuid(),
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  plan: ActionPlanContextSchema.nullable(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
    .nullable(),
});
export const HandoffFindingsSchema = z.object({
  turnId: NativeIdSchema,
  itemId: NativeIdSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(8192),
});
export const HandoffPhaseSchema = z.enum(['review', 'feedback']);
export const HandoffCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    id: z.uuid(),
    runtimeEpoch: z.uuid(),
    sourceThreadId: z.uuid(),
    purpose: z.enum(['challenge', 'review']),
    commit: HandoffSourceSchema.shape.commit.default(null),
  }),
  z.strictObject({ kind: z.literal('show'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('preview'), id: z.uuid(), phase: HandoffPhaseSchema }),
  z.strictObject({
    kind: z.literal('send'),
    id: z.uuid(),
    phase: HandoffPhaseSchema,
    expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal('collect'),
    id: z.uuid(),
    turnId: NativeIdSchema,
    itemId: NativeIdSchema,
    limit: z.number().int().min(1).max(128).default(32),
    cursor: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    kind: z.literal('list'),
    workspaceRoot: z.string().min(1).max(4096),
    sourceThreadId: z.uuid().optional(),
    limit: z.number().int().min(1).max(128).default(32),
    cursor: z.string().min(1).max(16_384).optional(),
  }),
]);
export type IHandoffCommand = z.infer<typeof HandoffCommandSchema>;
export type IHandoffPhase = z.infer<typeof HandoffPhaseSchema>;
export type IHandoffSource = z.infer<typeof HandoffSourceSchema>;
export type IHandoffFindings = z.infer<typeof HandoffFindingsSchema>;

// delivery acknowledgement and native turn completion are deliberately separate
export const HandoffDeliverySchema = z.object({
  actionId: z.uuid().nullable(),
  delivery: z.enum([
    'prepared',
    'queued',
    'submitted',
    'delivered',
    'uncertain',
    'failed',
    'canceled',
  ]),
  completion: ActionReceiptSchema.shape.completion,
  nativeTurnId: NativeIdSchema.nullable(),
});
export const HandoffSummarySchema = z.object({
  id: z.uuid(),
  purpose: z.enum(['challenge', 'review']),
  source: HandoffSourceSchema,
  targetThreadId: z.uuid().nullable(),
  targetNativeId: NativeIdSchema.nullable(),
  targetProvider: ProviderIdSchema,
  creation: HandoffDeliverySchema,
  review: HandoffDeliverySchema,
  feedback: HandoffDeliverySchema,
  hasFindings: z.boolean(),
  createdAt: z.number().int(),
});
export const HandoffSchema = HandoffSummarySchema.extend({
  findings: HandoffFindingsSchema.nullable(),
});
export type IHandoff = z.infer<typeof HandoffSchema>;
export type IHandoffSummary = z.infer<typeof HandoffSummarySchema>;
export const HandoffPreviewSchema = z.object({
  handoffId: z.uuid(),
  phase: HandoffPhaseSchema,
  state: z.enum([
    'ready',
    'missing-skill',
    'skill-unavailable',
    'target-unavailable',
    'source-changed',
    'findings-unavailable',
  ]),
  targetThreadId: z.uuid().nullable(),
  targetNativeId: NativeIdSchema.nullable(),
  skillId: z.string().nullable(),
  text: z.string().max(16_384).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IHandoffPreview = z.infer<typeof HandoffPreviewSchema>;
export const HandoffResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('handoff'), handoff: HandoffSchema }),
  z.object({ kind: z.literal('preview'), preview: HandoffPreviewSchema }),
  z.object({
    kind: z.literal('page'),
    data: z.array(HandoffSummarySchema).max(128),
    nextCursor: z.string().nullable(),
  }),
]);
export type IHandoffResult = z.infer<typeof HandoffResultSchema>;
