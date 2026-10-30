import { z } from 'zod';

import { ProviderIdSchema } from '../providers/index.js';
import { SessionSettingsSchema, TurnSettingsSchema } from '../configuration/index.js';
import { AccountControlCommandSchema } from '../accounts/index.js';
import { ExtensionControlCommandSchema } from '../extensions/index.js';

import { MessageInputSchema, NativeSkillInputSchema } from '../skills/index.js';

import { NativeIdSchema, NativeLineageSchema } from '../identities/index.js';
import { BoundInputFileSchema, MAX_INPUT_FILES } from '../inputs/index.js';
import { TurnResultSchema, OutputSchemaSchema } from '../results/index.js';

// queue payloads preserve the exact native selection, content hashes and turn options
export const PreparedInputSchema = z.object({
  text: z.string().min(1).max(65_536),
  skill: NativeSkillInputSchema.nullable(),
  files: z.array(BoundInputFileSchema).max(MAX_INPUT_FILES),
  settings: TurnSettingsSchema,
});
export type IPreparedInput = z.infer<typeof PreparedInputSchema>;

// explicit local intent; native RPC methods and arbitrary configuration are never accepted
const ThreadIdSchema = z.uuid();
const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const TextSchema = z.string().min(1).max(65_536);
const ActiveTargetFields = { threadId: ThreadIdSchema, expectedTurnId: NativeIdSchema };

export const ActionCommandSchema = z.discriminatedUnion('kind', [
  ...AccountControlCommandSchema.options,
  ...ExtensionControlCommandSchema.options,
  z.strictObject({
    kind: z.literal('thread-create'),
    provider: ProviderIdSchema,
    workspaceRoot: z.string().min(1).max(4096),
    name: NameSchema,
    settings: SessionSettingsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('thread-adopt'),
    provider: ProviderIdSchema,
    workspaceRoot: z.string().min(1).max(4096),
    nativeId: NativeIdSchema,
    name: NameSchema,
    operatorConfirmation: z.string().min(1).max(1024),
  }),
  z.strictObject({
    kind: z.literal('thread-resume'),
    threadId: ThreadIdSchema,
    operatorConfirmation: z.string().trim().min(1).max(1024),
    settings: SessionSettingsSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('thread-close'), threadId: ThreadIdSchema }),
  z.strictObject({ kind: z.literal('thread-fork'), threadId: ThreadIdSchema, name: NameSchema }),
  z.strictObject({ kind: z.literal('thread-archive'), threadId: ThreadIdSchema }),
  z.strictObject({ kind: z.literal('thread-unarchive'), threadId: ThreadIdSchema }),
  z.strictObject({ kind: z.literal('thread-compact'), threadId: ThreadIdSchema }),
  z.strictObject({
    kind: z.literal('thread-revert'),
    threadId: ThreadIdSchema,
    beforeTurnId: NativeIdSchema,
  }),
  z.strictObject({
    kind: z.literal('thread-recover'),
    threadId: ThreadIdSchema,
    recovery: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('resume') }),
      z.strictObject({ kind: z.literal('attach'), nativeId: NativeIdSchema }),
      z.strictObject({ kind: z.literal('create') }),
    ]),
    operatorConfirmation: z.string().trim().min(1).max(1024),
  }),
  z.strictObject({ kind: z.literal('thread-rename'), threadId: ThreadIdSchema, name: NameSchema }),
  z.strictObject({
    kind: z.literal('message'),
    threadId: ThreadIdSchema,
    input: MessageInputSchema,
    settings: TurnSettingsSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('steer'), ...ActiveTargetFields, text: TextSchema }),
  z.strictObject({
    kind: z.literal('queue'),
    ...ActiveTargetFields,
    input: MessageInputSchema,
    settings: TurnSettingsSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('interrupt'), ...ActiveTargetFields }),
  z.strictObject({ kind: z.literal('queue-send'), queuedActionId: z.uuid() }),
  z.strictObject({ kind: z.literal('queue-cancel'), queuedActionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('native-reply'),
    ...ActiveTargetFields,
    approvalId: z.uuid(),
    response: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('decision'),
        decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
      }),
      z.strictObject({
        kind: z.literal('permission'),
        decision: z.enum(['accept', 'decline']),
        scope: z.enum(['turn', 'session']),
      }),
      z.strictObject({
        kind: z.literal('answers'),
        answers: z
          .record(z.string().max(4096), z.array(z.string().max(8192)).min(1).max(32))
          .refine((answers) => Object.keys(answers).length <= 32)
          .transform((answers) =>
            Object.fromEntries(
              Object.entries(answers).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            ),
          ),
      }),
      z
        .strictObject({
          kind: z.literal('elicitation'),
          action: z.enum(['accept', 'decline', 'cancel']),
          content: z.record(z.string(), z.json()).nullable(),
        })
        .refine((reply) => new TextEncoder().encode(JSON.stringify(reply)).length <= 32_768),
    ]),
  }),
]);
export type IActionCommand = z.infer<typeof ActionCommandSchema>;

// identity survives lost client responses; a repeated UUID must carry the same validated request
export const ActionEnvelopeSchema = z
  .strictObject({
    id: z.uuid(),
    runtimeEpoch: z.uuid(),
    command: ActionCommandSchema,
  })
  .refine((action) => new TextEncoder().encode(JSON.stringify(action)).length <= 32_768);
export type IActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;

export const ActionReceiptSchema = z.object({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeEpoch: z.uuid(),
  kind: z.enum(ActionCommandSchema.options.map((command) => command.shape.kind.value)),
  provider: ProviderIdSchema.nullable(),
  controlState: z.enum(['accepted', 'applied', 'held']).nullable(),
  threadId: ThreadIdSchema.nullable(),
  // the native session of the action's thread, once HQ recorded it
  nativeThreadId: NativeIdSchema.nullable(),
  nativeTurnId: NativeIdSchema.nullable(),
  nativeRequestId: z.string().nullable(),
  delivery: z.enum(['queued', 'submitted', 'acknowledged', 'uncertain', 'failed', 'canceled']),
  completion: z.enum(['completed', 'failed', 'interrupted']).nullable(),
  failure: z
    .enum(['state-conflict', 'access-denied', 'agent-unavailable', 'operation-failed'])
    .nullable(),
  relatedActionId: z.uuid().nullable(),
  queuedInput: PreparedInputSchema.nullable(),
  result: TurnResultSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type IActionReceipt = z.infer<typeof ActionReceiptSchema>;

// collections omit queued input, final result bodies and the native thread; selected receipts retain them
export const ActionSummarySchema = ActionReceiptSchema.omit({
  nativeThreadId: true,
  queuedInput: true,
  result: true,
});
export type IActionSummary = z.infer<typeof ActionSummarySchema>;

/*
 * A receipt once it reached what an action wait waited for, or as it stood when the wait's time
 * ran out, with `isTimedOut` set. The receipt is null for an unknown action.
 */
export const ActionWaitSchema = z.object({
  receipt: ActionReceiptSchema.nullable(),
  isTimedOut: z.boolean(),
});
export type IActionWait = z.infer<typeof ActionWaitSchema>;

// control is separate from the native thread's discovery title and historical visibility
export const ManagedThreadSchema = z.object({
  id: ThreadIdSchema,
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema.nullable(),
  nativeLineage: NativeLineageSchema.nullable(),
  forkedFromThreadId: ThreadIdSchema.nullable(),
  isArchived: z.boolean(),
  name: NameSchema,
  workspaceRoot: z.string(),
  ownership: z.enum(['managed', 'uncertain']),
  runtimeEpoch: z.uuid().nullable(),
  activeTurnId: NativeIdSchema.nullable(),
  state: z.enum([
    'creating',
    'inactive',
    'idle',
    'starting',
    'running',
    'waiting-input',
    'waiting-approval',
    'stopping',
    'completed',
    'failed',
    'interrupted',
    'unknown',
  ]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type IManagedThread = z.infer<typeof ManagedThreadSchema>;

// sensitive native presentation exists only while its owning live request is available
export const NativeElicitationSchema = z
  .object({
    mode: z.enum(['form', 'url']),
    serverName: z.string().min(1).max(256),
    message: z.string().max(8192),
    requestedSchema: OutputSchemaSchema.nullable(),
    url: z
      .url({ protocol: /^https?$/ })
      .max(8192)
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      })
      .nullable(),
    elicitationId: z.string().min(1).max(4096).nullable(),
  })
  .refine((request) =>
    request.mode === 'form'
      ? request.requestedSchema?.type === 'object' &&
        request.url === null &&
        request.elicitationId === null
      : request.requestedSchema === null && request.url !== null && request.elicitationId !== null,
  );
export type INativeElicitation = z.infer<typeof NativeElicitationSchema>;

// prompt strings are untrusted display content, never HTML or terminal escape instructions
export const ApprovalPresentationSchema = z
  .object({
    kind: z.enum(['command', 'file-change', 'permission', 'question', 'elicitation']),
    isBlocking: z.boolean(),
    title: z.string(),
    detail: z.string(),
    decisions: z.array(z.enum(['accept', 'acceptForSession', 'decline', 'cancel'])).max(4),
    questions: z
      .array(
        z.object({
          id: z.string(),
          header: z.string(),
          question: z.string(),
          isSecret: z.boolean(),
          isOther: z.boolean(),
          allowsMultiple: z.boolean(),
          options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
        }),
      )
      .max(32),
    elicitation: NativeElicitationSchema.optional(),
  })
  .refine(
    (presentation) =>
      new TextEncoder().encode(JSON.stringify(presentation)).length <= 131_072 &&
      (presentation.kind === 'elicitation') === (presentation.elicitation !== undefined),
  );
export type IApprovalPresentation = z.infer<typeof ApprovalPresentationSchema>;

// durable metadata remains queryable after resolution without retaining prompt bodies or answers
export const NativeApprovalSummarySchema = z.object({
  id: z.uuid(),
  threadId: ThreadIdSchema,
  nativeTurnId: NativeIdSchema,
  runtimeEpoch: z.uuid(),
  kind: ApprovalPresentationSchema.shape.kind,
  state: z.enum(['pending', 'answered', 'expired']),
  replyActionId: z.uuid().nullable(),
  isBlocking: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type INativeApprovalSummary = z.infer<typeof NativeApprovalSummarySchema>;
export const NativeApprovalSchema = NativeApprovalSummarySchema.extend({
  presentation: ApprovalPresentationSchema.nullable(),
});
export type INativeApproval = z.infer<typeof NativeApprovalSchema>;

// lifecycle metadata provides reconnect ordering without mirroring token/tool output
export const LifecycleEventSchema = z.object({
  sequence: z.number().int().positive(),
  runtimeEpoch: z.uuid(),
  threadId: ThreadIdSchema.nullable(),
  actionId: z.uuid().nullable(),
  nativeTurnId: NativeIdSchema.nullable(),
  nativeItemId: NativeIdSchema.nullable(),
  kind: z.enum([
    'action-admitted',
    'action-updated',
    'thread-updated',
    'approval-opened',
    'approval-resolved',
    'item-started',
    'item-completed',
    'native-unavailable',
  ]),
  createdAt: z.number().int(),
});
export type ILifecycleEvent = z.infer<typeof LifecycleEventSchema>;
