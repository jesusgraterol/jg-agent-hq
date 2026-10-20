import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PUBLIC_ERROR_MESSAGES } from './constants.js';
import { SkillIdSchema, SkillPageSchema, SkillPreviewSchema } from './skills/index.js';

import { NativeIdSchema } from './identities/index.js';
import {
  ActionEnvelopeSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
  LifecycleEventSchema,
} from './actions/index.js';

// opaque native identifiers, bounded independently of provider-specific formats
const CursorSchema = z.string().min(1).max(16_384);
const PageFields = {
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: CursorSchema.optional(),
};
const TargetFields = {
  provider: z.enum(['codex', 'claude']),
  workspaceRoot: z.string().min(1).max(4096),
  nativeId: NativeIdSchema,
};

// only implemented operations can be admitted; native RPC is never exposed
export const HqRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('stop') }),
  z.strictObject({
    kind: z.literal('threads'),
    provider: TargetFields.provider,
    workspaceRoot: TargetFields.workspaceRoot,
    search: z.string().max(1024).optional(),
    ...PageFields,
  }),
  z.strictObject({ kind: z.literal('thread'), ...TargetFields }),
  z.strictObject({ kind: z.literal('turns'), ...TargetFields, ...PageFields }),
  z.strictObject({
    kind: z.literal('items'),
    ...TargetFields,
    turnId: NativeIdSchema.optional(),
    ...PageFields,
  }),
  z.strictObject({ kind: z.literal('usage'), provider: TargetFields.provider }),
  z.strictObject({
    kind: z.literal('skills'),
    threadId: z.uuid(),
    search: z.string().max(1024).optional(),
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('skill-preview'),
    threadId: z.uuid(),
    skillId: SkillIdSchema,
    arguments: z.string().max(16_384),
  }),
  z.strictObject({ kind: z.literal('action'), action: ActionEnvelopeSchema }),
  z.strictObject({ kind: z.literal('receipt'), actionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('managed-threads'),
    workspaceRoot: TargetFields.workspaceRoot,
    ...PageFields,
  }),
  z.strictObject({ kind: z.literal('managed-thread'), threadId: z.uuid() }),
  z.strictObject({
    kind: z.literal('managed-thread-name'),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i),
  }),
  z.strictObject({ kind: z.literal('suggest-thread-name'), topic: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('actions'), threadId: z.uuid(), ...PageFields }),
  z.strictObject({
    kind: z.literal('events'),
    threadId: z.uuid(),
    after: z.number().int().nonnegative().default(0),
    limit: PageFields.limit,
  }),
  z.strictObject({ kind: z.literal('approvals'), threadId: z.uuid() }),
  z.strictObject({ kind: z.literal('live-items'), threadId: z.uuid() }),
]);
export type IHqRequest = z.infer<typeof HqRequestSchema>;
export type IHqRequestInput = z.input<typeof HqRequestSchema>;

// native discovery is external/read-only until explicitly adopted for control
export const ThreadSummarySchema = z.object({
  provider: z.enum(['codex', 'claude']),
  nativeId: NativeIdSchema,
  workspaceRoot: z.string(),
  name: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nativeState: z.enum(['notLoaded', 'idle', 'systemError', 'active', 'unknown']),
  ownership: z.enum(['external', 'managed', 'uncertain']),
  managedId: z.uuid().nullable(),
  historyState: z.enum(['available', 'unavailable']),
});
export type IThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const TurnSummarySchema = z.object({
  nativeId: NativeIdSchema,
  state: z.enum(['completed', 'interrupted', 'failed', 'inProgress', 'unknown']),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
export type ITurnSummary = z.infer<typeof TurnSummarySchema>;

// explicit presentation fields; unknown native item kinds are labeled unsupported
export const HistoryItemSchema = z.object({
  nativeId: NativeIdSchema,
  turnId: NativeIdSchema,
  nativeType: z.string(),
  kind: z.enum(['user-message', 'agent-message', 'command', 'file-change', 'unsupported']),
  text: z.string(),
  isTruncated: z.boolean(),
});
export type IHistoryItem = z.infer<typeof HistoryItemSchema>;
export const LiveItemsSchema = z.object({
  data: z.array(HistoryItemSchema.extend({ state: z.enum(['active', 'awaiting-flush']) })).max(128),
  hasGap: z.boolean(),
});

export const UsageWindowSchema = z.object({
  id: z.string(),
  bucket: z.string(),
  label: z.string().nullable(),
  window: z.enum(['primary', 'secondary']),
  usedPercent: z.number().finite().min(0),
  remainingPercent: z.number().min(0).max(100),
  durationMinutes: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nullable(),
});
export const UsageSnapshotSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  state: z.enum(['available', 'exhausted', 'stale', 'unavailable']),
  source: z.literal('native'),
  observedAt: z.number().int().nullable(),
  ordinaryUsageAllowed: z.boolean().nullable(),
  windows: z.array(UsageWindowSchema).max(MAX_PAGE_SIZE),
});
export type IUsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const RuntimeStatusSchema = z.object({
  runtimeEpoch: z.uuid(),
  pid: z.number().int().positive(),
  startedAt: z.number().int(),
  store: z.enum(['ready', 'unavailable']),
  codex: z.object({
    state: z.enum(['ready', 'unavailable']),
    userAgent: z.string(),
    steering: z.literal('available'),
  }),
  claude: z.object({
    state: z.enum(['idle', 'ready', 'unavailable']),
    version: z.string().nullable(),
    steering: z.literal('unavailable'),
  }),
});
export type IRuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
const PageResultFields = { nextCursor: CursorSchema.nullable(), source: z.literal('native') };
export const HqResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), result: RuntimeStatusSchema }),
  z.object({
    kind: z.literal('stop'),
    result: z.object({ accepted: z.literal(true), runtimeEpoch: z.uuid() }),
  }),
  z.object({
    kind: z.literal('threads'),
    result: z.object({
      data: z.array(ThreadSummarySchema).max(MAX_PAGE_SIZE),
      ...PageResultFields,
    }),
  }),
  z.object({ kind: z.literal('thread'), result: ThreadSummarySchema }),
  z.object({
    kind: z.literal('turns'),
    result: z.object({ data: z.array(TurnSummarySchema).max(MAX_PAGE_SIZE), ...PageResultFields }),
  }),
  z.object({
    kind: z.literal('items'),
    result: z.object({
      data: z.array(HistoryItemSchema).max(MAX_PAGE_SIZE),
      ...PageResultFields,
      history: z.literal('persisted'),
    }),
  }),
  z.object({ kind: z.literal('usage'), result: UsageSnapshotSchema }),
  z.object({ kind: z.literal('skills'), result: SkillPageSchema }),
  z.object({ kind: z.literal('skill-preview'), result: SkillPreviewSchema }),
  z.object({ kind: z.literal('action'), result: ActionReceiptSchema }),
  z.object({ kind: z.literal('receipt'), result: ActionReceiptSchema.nullable() }),
  z.object({
    kind: z.literal('managed-threads'),
    result: z.object({
      data: z.array(ManagedThreadSchema).max(MAX_PAGE_SIZE),
      nextCursor: CursorSchema.nullable(),
    }),
  }),
  z.object({ kind: z.literal('managed-thread'), result: ManagedThreadSchema.nullable() }),
  z.object({ kind: z.literal('managed-thread-name'), result: ManagedThreadSchema.nullable() }),
  z.object({
    kind: z.literal('suggest-thread-name'),
    result: z.object({ name: ManagedThreadSchema.shape.name }),
  }),
  z.object({
    kind: z.literal('actions'),
    result: z.object({
      data: z.array(ActionSummarySchema).max(MAX_PAGE_SIZE),
      nextCursor: CursorSchema.nullable(),
    }),
  }),
  z.object({
    kind: z.literal('events'),
    result: z.object({
      data: z.array(LifecycleEventSchema).max(MAX_PAGE_SIZE),
      hasMore: z.boolean(),
    }),
  }),
  z.object({ kind: z.literal('approvals'), result: z.array(NativeApprovalSchema).max(32) }),
  z.object({ kind: z.literal('live-items'), result: LiveItemsSchema }),
]);
export type IHqResponse = z.infer<typeof HqResponseSchema>;

export const ErrorKindSchema = z.enum(
  Object.keys(PUBLIC_ERROR_MESSAGES) as [
    keyof typeof PUBLIC_ERROR_MESSAGES,
    ...(keyof typeof PUBLIC_ERROR_MESSAGES)[],
  ],
);
export type IErrorKind = z.infer<typeof ErrorKindSchema>;
export const IpcRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  runtimeEpoch: z.uuid(),
  command: HqRequestSchema,
});
export const IpcResponseSchema = z.discriminatedUnion('success', [
  z.object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    success: z.literal(true),
    response: HqResponseSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    success: z.literal(false),
    error: z.object({ kind: ErrorKindSchema, message: z.string() }),
  }),
]);
export type IIpcResponse = z.infer<typeof IpcResponseSchema>;
