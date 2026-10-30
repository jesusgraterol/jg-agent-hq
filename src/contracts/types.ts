import { z } from 'zod';

import {
  EvidenceRequestSchema,
  SessionDiscoveryRequestSchema,
  EvidencePageSchema,
  HistoryKindSchema,
  HistoryProvenanceSchema,
} from './evidence/index.js';

import {
  AccountRequestSchema,
  AccountObservationSchema,
  LoginRequestSchema,
  LoginObservationSchema,
} from './accounts/index.js';
import {
  McpRequestSchema,
  McpServerPageSchema,
  McpToolPageSchema,
  McpResourcePageSchema,
} from './extensions/index.js';

import {
  MAX_PROVIDERS,
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
  ProviderStatusSchema,
} from './providers/index.js';

import {
  DEFAULT_PAGE_SIZE,
  MAX_ITEM_IMAGE_BYTES,
  MAX_ITEM_IMAGES,
  MAX_ITEM_TEXT_LENGTH,
  MAX_PAGE_SIZE,
  PUBLIC_ERROR_MESSAGES,
} from './constants.js';
import { SkillIdSchema, SkillPageSchema, SkillPreviewSchema } from './skills/index.js';

import { NativeIdSchema, CursorSchema, NativeLineageSchema } from './identities/index.js';
import { ProviderModelPageSchema, ProviderModelsRequestSchema } from './models/index.js';
import { ConfigurationRequestSchema, SessionConfigurationSchema } from './configuration/index.js';
import {
  ObservationPaceSchema,
  SessionStateSchema,
  SessionTransitionPageSchema,
} from './sessions/index.js';
import {
  ActionEnvelopeSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ActionWaitSchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
  LifecycleEventSchema,
} from './actions/index.js';
import { LocksSchema } from './locks/index.js';

// pagination is validated before adapters receive a native continuation
const PageFields = {
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: CursorSchema.optional(),
};
const TargetFields = {
  provider: ProviderIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  nativeId: NativeIdSchema,
};

// only implemented operations can be admitted; native RPC is never exposed
export const HqRequestSchema = z.discriminatedUnion('kind', [
  EvidenceRequestSchema,
  SessionDiscoveryRequestSchema,
  AccountRequestSchema,
  ...McpRequestSchema.options,
  ProviderModelsRequestSchema,
  ConfigurationRequestSchema,
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({
    kind: z.literal('capabilities'),
    provider: ProviderIdSchema,
    threadId: z.uuid().optional(),
  }),
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
  // newest first: a page toward older items, or one item by its native ID within its turn
  z
    .strictObject({
      kind: z.literal('items'),
      ...TargetFields,
      turnId: NativeIdSchema.optional(),
      nativeItemId: NativeIdSchema.optional(),
      textLimit: z.number().int().min(1).max(MAX_ITEM_TEXT_LENGTH).default(MAX_ITEM_TEXT_LENGTH),
      ...PageFields,
    })
    .refine(
      (command) =>
        command.nativeItemId === undefined ||
        (command.turnId !== undefined && command.cursor === undefined),
      { message: 'One item is read within its turn, without a cursor', path: ['nativeItemId'] },
    ),
  // one item's detail, by its native ID within its turn
  z.strictObject({
    kind: z.literal('item-detail'),
    ...TargetFields,
    turnId: NativeIdSchema,
    nativeItemId: NativeIdSchema,
  }),
  // one image of an item, by its index in the item's detail
  z.strictObject({
    kind: z.literal('item-image'),
    ...TargetFields,
    turnId: NativeIdSchema,
    nativeItemId: NativeIdSchema,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_ITEM_IMAGES - 1),
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
  // waits until the receipt has a native thread ID, or a final delivery state, or the time runs out
  z.strictObject({
    kind: z.literal('action-wait'),
    actionId: z.uuid(),
    until: z.enum(['native', 'settled']),
    timeoutMs: z.number().int().min(1).max(30_000),
  }),
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
    kind: z.literal('provider-actions'),
    provider: ProviderIdSchema,
    ...PageFields,
  }),
  LoginRequestSchema,
  z.strictObject({
    kind: z.literal('events'),
    threadId: z.uuid(),
    after: z.number().int().nonnegative().default(0),
    limit: PageFields.limit,
  }),
  z.strictObject({
    kind: z.literal('approvals'),
    threadId: z.uuid(),
    state: NativeApprovalSchema.shape.state.optional(),
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('live-items'),
    threadId: z.uuid(),
    afterRevision: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal('session-states'),
    afterSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(128).default(32),
  }),
  z.strictObject({ kind: z.literal('active-sessions') }),
  z.strictObject({
    kind: z.literal('unstarted-threads'),
    provider: TargetFields.provider,
    workspaceRoot: TargetFields.workspaceRoot,
  }),
  z.strictObject({ kind: z.literal('observation-pace'), pace: ObservationPaceSchema }),
  // the machine's jg-locks locks; HQ only reads them
  z.strictObject({ kind: z.literal('locks') }),
]);
export type IHqRequest = z.infer<typeof HqRequestSchema>;
export type IHqRequestInput = z.input<typeof HqRequestSchema>;

// how a terminal runs a Claude session: in its own window, or in Claude Code's background service
export const SessionTerminalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interactive') }),
  z.object({ kind: z.literal('background'), attachId: z.string().min(1).max(64) }),
]);
export type ISessionTerminal = z.infer<typeof SessionTerminalSchema>;

// native discovery is external/read-only until explicitly adopted for control
export const ThreadSummarySchema = z.object({
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
  nativeLineage: NativeLineageSchema.nullable(),
  workspaceRoot: z.string(),
  name: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nativeState: z.enum(['notLoaded', 'idle', 'systemError', 'active', 'unknown']),
  state: SessionStateSchema,
  ownership: z.enum(['external', 'managed', 'uncertain']),
  managedId: z.uuid().nullable(),
  historyState: z.enum(['available', 'unavailable']),
  // the terminal that runs the session, while one does; always null for Codex
  terminal: SessionTerminalSchema.nullable(),
});
export type IThreadSummary = z.infer<typeof ThreadSummarySchema>;

// every running and waiting session, newest state change first, with whether more are active
export const ActiveSessionsSchema = z.object({
  data: z.array(ThreadSummarySchema).max(MAX_PAGE_SIZE),
  isTruncated: z.boolean(),
});
export type IActiveSessions = z.infer<typeof ActiveSessionsSchema>;

// one workspace's managed threads that no turn has started yet, newest first, with whether more exist
export const UnstartedThreadsSchema = z.object({
  data: z.array(ThreadSummarySchema).max(DEFAULT_PAGE_SIZE),
  isTruncated: z.boolean(),
});
export type IUnstartedThreads = z.infer<typeof UnstartedThreadsSchema>;

export const TurnSummarySchema = z.object({
  nativeId: NativeIdSchema,
  state: z.enum(['completed', 'interrupted', 'failed', 'inProgress', 'unknown']),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
export type ITurnSummary = z.infer<typeof TurnSummarySchema>;

// one file a file change touched, with the lines it added and removed
export const HistoryFileSchema = z.object({
  path: z.string().min(1).max(4096),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type IHistoryFile = z.infer<typeof HistoryFileSchema>;

/*
 * Explicit presentation fields; unknown native item kinds are labeled unsupported. `callId` pairs
 * a tool call with its result, `outcome` is what the provider recorded, null when unknown or
 * running, and `files` lists a file change's files; both come from the full record, so cutting
 * the text never changes them. `createdAt` is the item's time in Unix milliseconds, or null when
 * the provider records none.
 */
export const HistoryItemSchema = z.object({
  nativeId: NativeIdSchema,
  turnId: NativeIdSchema,
  nativeType: z.string(),
  kind: HistoryKindSchema,
  provenance: HistoryProvenanceSchema,
  text: z.string(),
  isTruncated: z.boolean(),
  callId: z.string().min(1).max(4096).nullable(),
  outcome: z.enum(['succeeded', 'failed']).nullable(),
  files: z.array(HistoryFileSchema).max(MAX_PAGE_SIZE),
  createdAt: z.number().int().nullable(),
});
export type IHistoryItem = z.infer<typeof HistoryItemSchema>;

// the image formats HQ recognizes by their first bytes
export const ItemImageMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export type IItemImageMediaType = z.infer<typeof ItemImageMediaTypeSchema>;

/*
 * What a developer inspects in one item, beyond its display text. Each part is null, or empty,
 * when the item has none, and a field the provider doesn't record is null. Output and results
 * keep their last 65,536 UTF-16 code units, with the start-cut flag set when they lost their
 * start. `images` lists every image the item holds or names, in order, by its index, with its
 * format and size when the item holds the image itself.
 */
export const ItemDetailSchema = z.object({
  item: HistoryItemSchema,
  command: z
    .object({
      command: z.string().nullable(),
      output: z.string().max(MAX_ITEM_TEXT_LENGTH).nullable(),
      isOutputStartCut: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  tool: z
    .object({
      server: z.string().nullable(),
      name: z.string().nullable(),
      input: z.string().nullable(),
      result: z.string().max(MAX_ITEM_TEXT_LENGTH).nullable(),
      isResultStartCut: z.boolean(),
    })
    .nullable(),
  files: z.array(HistoryFileSchema.extend({ diff: z.string() })).max(MAX_PAGE_SIZE),
  images: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(MAX_ITEM_IMAGES - 1),
        mediaType: ItemImageMediaTypeSchema.nullable(),
        byteCount: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(MAX_ITEM_IMAGES),
});
export type IItemDetail = z.infer<typeof ItemDetailSchema>;

// an image's bytes in base64, recognized by its first bytes and at most 4 MiB
export const ItemImageSchema = z.object({
  mediaType: ItemImageMediaTypeSchema,
  data: z
    .string()
    .max(Math.ceil(MAX_ITEM_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type IItemImage = z.infer<typeof ItemImageSchema>;
export const LiveItemsSchema = z.object({
  revision: z.number().int().nonnegative(),
  unchanged: z.boolean(),
  data: z.array(HistoryItemSchema.extend({ state: z.enum(['active', 'awaiting-flush']) })).max(128),
  hasGap: z.boolean(),
});

// exact native credit observations; balances have no assumed currency or arithmetic semantics
export const UsageCreditsSchema = z.object({
  bucket: z.string().max(256),
  hasCredits: z.boolean(),
  isUnlimited: z.boolean(),
  balance: z.string().max(256).nullable(),
});
export type IUsageCredits = z.infer<typeof UsageCreditsSchema>;

// availability is independent of the provider's potentially capped reset-credit detail list
export const UsageResetCreditsSchema = z.object({
  availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type IUsageResetCredits = z.infer<typeof UsageResetCreditsSchema>;

// native model/surface scope identifies independent account meters
export const UsageWindowScopeSchema = z.object({
  model: z
    .object({ id: z.string().max(256).nullable(), displayName: z.string().max(256) })
    .nullable(),
  surface: z.string().max(256).nullable(),
});
export type IUsageWindowScope = z.infer<typeof UsageWindowScopeSchema>;

export const UsageWindowSchema = z.object({
  id: z.string(),
  bucket: z.string(),
  label: z.string().nullable(),
  window: z.enum(['primary', 'secondary']),
  usedPercent: z.number().finite().min(0),
  remainingPercent: z.number().min(0).max(100),
  durationMinutes: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nullable(),
  period: z.enum(['five-hour', 'seven-day', 'other']).optional(),
  nativeKind: z.string().max(256).nullable().optional(),
  group: z.string().max(256).nullable().optional(),
  scope: UsageWindowScopeSchema.nullable().optional(),
});
export const UsageSnapshotSchema = z.object({
  provider: ProviderIdSchema,
  state: z.enum(['available', 'exhausted', 'stale', 'unavailable']),
  source: z.literal('native'),
  observedAt: z.number().int().nullable(),
  ordinaryUsageAllowed: z.boolean().nullable(),
  windows: z.array(UsageWindowSchema).max(MAX_PAGE_SIZE),
  credits: z.array(UsageCreditsSchema).max(MAX_PAGE_SIZE).nullable().optional(),
  resetCredits: UsageResetCreditsSchema.nullable().optional(),
});
export type IUsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const RuntimeStatusSchema = z.object({
  runtimeEpoch: z.uuid(),
  pid: z.number().int().positive(),
  startedAt: z.number().int(),
  store: z.enum(['ready', 'unavailable']),
  providers: z.array(ProviderStatusSchema).max(MAX_PROVIDERS),
});
export type IRuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
const PageResultFields = { nextCursor: CursorSchema.nullable(), source: z.literal('native') };
export const HqResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session-evidence'), result: EvidencePageSchema }),
  z.object({
    kind: z.literal('sessions'),
    result: z.object({
      data: z.array(ThreadSummarySchema.extend({ isNameTruncated: z.boolean() })).max(128),
      nextCursor: CursorSchema.nullable(),
      source: z.literal('native'),
    }),
  }),
  z.object({ kind: z.literal('account'), result: AccountObservationSchema }),
  z.object({ kind: z.literal('login'), result: LoginObservationSchema }),
  z.object({
    kind: z.literal('provider-actions'),
    result: z.object({
      data: z.array(ActionSummarySchema).max(128),
      nextCursor: z.string().nullable(),
    }),
  }),
  z.object({ kind: z.literal('mcp-servers'), result: McpServerPageSchema }),
  z.object({ kind: z.literal('mcp-tools'), result: McpToolPageSchema }),
  z.object({ kind: z.literal('mcp-resources'), result: McpResourcePageSchema }),
  z.object({ kind: z.literal('configuration'), result: SessionConfigurationSchema }),
  z.object({ kind: z.literal('models'), result: ProviderModelPageSchema }),
  z.object({ kind: z.literal('status'), result: RuntimeStatusSchema }),
  z.object({ kind: z.literal('capabilities'), result: ProviderCapabilitiesSchema }),
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
  // null for an unknown or hidden item, or one in another turn
  z.object({ kind: z.literal('item-detail'), result: ItemDetailSchema.nullable() }),
  z.object({ kind: z.literal('item-image'), result: ItemImageSchema }),
  z.object({ kind: z.literal('usage'), result: UsageSnapshotSchema }),
  z.object({ kind: z.literal('skills'), result: SkillPageSchema }),
  z.object({ kind: z.literal('skill-preview'), result: SkillPreviewSchema }),
  z.object({ kind: z.literal('action'), result: ActionReceiptSchema }),
  z.object({ kind: z.literal('receipt'), result: ActionReceiptSchema.nullable() }),
  z.object({ kind: z.literal('action-wait'), result: ActionWaitSchema }),
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
  z.object({
    kind: z.literal('approvals'),
    result: z.object({
      data: z.array(NativeApprovalSchema).max(MAX_PAGE_SIZE),
      nextCursor: CursorSchema.nullable(),
    }),
  }),
  z.object({ kind: z.literal('live-items'), result: LiveItemsSchema }),
  z.object({ kind: z.literal('session-states'), result: SessionTransitionPageSchema }),
  z.object({ kind: z.literal('active-sessions'), result: ActiveSessionsSchema }),
  z.object({ kind: z.literal('unstarted-threads'), result: UnstartedThreadsSchema }),
  z.object({
    kind: z.literal('observation-pace'),
    result: z.object({ pace: ObservationPaceSchema }),
  }),
  z.object({ kind: z.literal('locks'), result: LocksSchema }),
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
