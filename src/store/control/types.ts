import { z } from 'zod';

import {
  ActionEnvelopeSchema,
  ActionPlanContextSchema,
  PreparedInputSchema,
  TurnResultSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
  NativeApprovalSummarySchema,
  LifecycleEventSchema,
  NativeLineageSchema,
} from '../../contracts/index.js';

// these shapes mirror SQLite columns; transformations retain the public camelCase contracts
export const ThreadRowSchema = z.object({
  id: ManagedThreadSchema.shape.id,
  provider: ManagedThreadSchema.shape.provider,
  native_id: ManagedThreadSchema.shape.nativeId,
  native_lineage: z.string().nullable(),
  fork_source_thread_id: z.uuid().nullable(),
  is_archived: z.number().int().min(0).max(1),
  name: ManagedThreadSchema.shape.name,
  workspace_root: z.string(),
  ownership: ManagedThreadSchema.shape.ownership,
  runtime_epoch: z.uuid().nullable(),
  active_turn_id: ManagedThreadSchema.shape.activeTurnId,
  last_turn_id: ManagedThreadSchema.shape.activeTurnId,
  last_turn_state: ActionReceiptSchema.shape.completion,
  pending_action_id: z.uuid().nullable(),
  state: ManagedThreadSchema.shape.state,
  registration_action_id: z.uuid(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type IThreadRow = z.infer<typeof ThreadRowSchema>;
export const ActionRowSchema = z.object({
  id: z.uuid(),
  digest: ActionReceiptSchema.shape.digest,
  requested_runtime_epoch: z.uuid(),
  runtime_epoch: z.uuid(),
  kind: ActionReceiptSchema.shape.kind,
  thread_id: z.uuid().nullable(),
  expected_turn_id: ActionReceiptSchema.shape.nativeTurnId,
  native_turn_id: ActionReceiptSchema.shape.nativeTurnId,
  native_request_id: z.string().nullable(),
  delivery: ActionReceiptSchema.shape.delivery,
  completion: ActionReceiptSchema.shape.completion,
  failure: ActionReceiptSchema.shape.failure,
  related_action_id: z.uuid().nullable(),
  queued_input: z.string().nullable(),
  result: z.string().nullable(),
  plan_context: z.string().nullable(),
  requested_name: ManagedThreadSchema.shape.name.nullable(),
  queue_ready: z.number().int().min(0).max(1),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type IActionRow = z.infer<typeof ActionRowSchema>;

const NativeIdSchema = ManagedThreadSchema.shape.nativeId.unwrap();
const OutcomeFields = { actionId: z.uuid(), requestId: z.string().min(1).max(256) };
export const NativeOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('created'),
    ...OutcomeFields,
    nativeId: NativeIdSchema,
    nativeLineage: NativeLineageSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('resumed'),
    ...OutcomeFields,
    nativeState: z.enum(['notLoaded', 'idle', 'systemError', 'active']),
    nativeLineage: NativeLineageSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('closed'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('cleaned'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('renamed'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('archived'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('unarchived'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('reverted'), ...OutcomeFields }),
  z.strictObject({
    kind: z.literal('compaction-accepted'),
    ...OutcomeFields,
    nativeTurnId: NativeIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('turn-accepted'),
    ...OutcomeFields,
    nativeTurnId: NativeIdSchema,
  }),
  z.strictObject({
    kind: z.literal('steer-accepted'),
    ...OutcomeFields,
    nativeTurnId: NativeIdSchema,
  }),
  z.strictObject({ kind: z.literal('interrupt-accepted'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('reply-written'), ...OutcomeFields }),
  z.strictObject({ kind: z.literal('uncertain'), ...OutcomeFields }),
  z.strictObject({
    kind: z.literal('failed'),
    ...OutcomeFields,
    failure: ActionReceiptSchema.shape.failure.unwrap(),
  }),
]);
export type INativeOutcome = z.infer<typeof NativeOutcomeSchema>;

const ProviderSchema = ManagedThreadSchema.shape.provider;
const NativeTurnFields = {
  provider: ProviderSchema,
  nativeThreadId: NativeIdSchema,
  nativeTurnId: NativeIdSchema,
};
export const NativeObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('turn-started'), ...NativeTurnFields }),
  z.strictObject({
    kind: z.literal('turn-completed'),
    ...NativeTurnFields,
    state: ActionReceiptSchema.shape.completion.unwrap(),
    result: TurnResultSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('item-started'),
    ...NativeTurnFields,
    nativeItemId: NativeIdSchema,
  }),
  z.strictObject({
    kind: z.literal('item-completed'),
    ...NativeTurnFields,
    nativeItemId: NativeIdSchema,
  }),
  z.strictObject({
    kind: z.literal('name-updated'),
    provider: ProviderSchema,
    nativeThreadId: NativeIdSchema,
    name: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.enum(['request-resolved', 'request-canceled']),
    provider: ProviderSchema,
    nativeThreadId: NativeIdSchema,
    requestId: z.string().min(1).max(8192),
  }),
  z.strictObject({
    kind: z.literal('native-unavailable'),
    provider: ProviderSchema,
    nativeThreadId: NativeIdSchema.optional(),
  }),
]);
export type INativeObservation = z.infer<typeof NativeObservationSchema>;

// only validated derivations of trusted configuration/native metadata cross this worker boundary
export const AdmissionSchema = z.strictObject({
  action: ActionEnvelopeSchema,
  prepared: z.strictObject({
    workspaceRoot: z.string().optional(),
    nativeId: NativeIdSchema.optional(),
    input: PreparedInputSchema.optional(),
    planContext: ActionPlanContextSchema.optional(),
  }),
});
export type IAdmission = z.infer<typeof AdmissionSchema>;
export const AdmissionResultSchema = z.object({
  receipt: ActionReceiptSchema,
  thread: ManagedThreadSchema.nullable(),
  isNew: z.boolean(),
  dispatchActionId: z.uuid().nullable(),
});
export type IAdmissionResult = z.infer<typeof AdmissionResultSchema>;
export const DispatchSchema = z.object({
  receipt: ActionReceiptSchema,
  thread: ManagedThreadSchema,
  input: PreparedInputSchema,
});
export type IDispatch = z.infer<typeof DispatchSchema>;
export const ObservationResultSchema = z.object({
  thread: ManagedThreadSchema.nullable(),
  canDispatchQueued: z.boolean(),
});
export type IObservationResult = z.infer<typeof ObservationResultSchema>;

// public cursors are decoded and query-bound before these trusted seek positions are sent
export const ControlPageSchema = z.strictObject({
  limit: z.number().int().min(1).max(128),
  position: z.strictObject({ createdAt: z.number().int(), id: z.uuid() }).nullable(),
});
export type IControlPage = z.infer<typeof ControlPageSchema>;
export const ApprovalPageRequestSchema = ControlPageSchema.extend({
  state: NativeApprovalSummarySchema.shape.state.optional(),
});
export type IApprovalPageRequest = z.infer<typeof ApprovalPageRequestSchema>;
export const EventPageSchema = z.strictObject({
  limit: z.number().int().min(1).max(128),
  after: z.number().int().nonnegative(),
  threadId: z.uuid(),
});
export type IEventPage = z.infer<typeof EventPageSchema>;

export const ApprovalRecordSchema = z.strictObject({
  provider: ProviderSchema,
  id: z.uuid(),
  nativeThreadId: NativeIdSchema,
  nativeTurnId: NativeIdSchema,
  requestId: z.string().min(1).max(8192),
  kind: NativeApprovalSchema.shape.kind,
  digest: ActionReceiptSchema.shape.digest,
  isBlocking: z.boolean(),
});
export type IApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

// bounded read results omit queued bodies in collection responses
export const ManagedThreadPageSchema = z.object({
  data: z.array(ManagedThreadSchema).max(128),
  hasMore: z.boolean(),
});
export const ActionPageSchema = z.object({
  data: z.array(ActionSummarySchema).max(128),
  hasMore: z.boolean(),
});
export const ApprovalPageSchema = z.object({
  data: z.array(NativeApprovalSummarySchema).max(128),
  hasMore: z.boolean(),
});
export const LifecyclePageSchema = z.object({
  data: z.array(LifecycleEventSchema).max(128),
  hasMore: z.boolean(),
});
export const ApprovalIdentitySchema = z.object({ id: z.uuid(), thread: ManagedThreadSchema });
