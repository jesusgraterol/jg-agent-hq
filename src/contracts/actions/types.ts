import { z } from 'zod';

import { MessageInputSchema, NativeSkillInputSchema } from '../skills/index.js';

import { NativeIdSchema } from '../identities/index.js';
import { PlanRevisionSchema } from '../plans/index.js';

// explicit local intent; native RPC methods and arbitrary configuration are never accepted
const ThreadIdSchema = z.uuid();
const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const TextSchema = z.string().min(1).max(65_536);
const ActiveTargetFields = { threadId: ThreadIdSchema, expectedTurnId: NativeIdSchema };

export const ActionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('thread-create'),
    provider: z.enum(['codex', 'claude']),
    workspaceRoot: z.string().min(1).max(4096),
    name: NameSchema,
  }),
  z.strictObject({
    kind: z.literal('thread-adopt'),
    provider: z.enum(['codex', 'claude']),
    workspaceRoot: z.string().min(1).max(4096),
    nativeId: NativeIdSchema,
    name: NameSchema,
    operatorConfirmation: z.string().min(1).max(1024),
  }),
  z.strictObject({
    kind: z.literal('thread-resume'),
    threadId: ThreadIdSchema,
    operatorConfirmation: z.string().trim().min(1).max(1024),
  }),
  z.strictObject({ kind: z.literal('thread-close'), threadId: ThreadIdSchema }),
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
  }),
  z.strictObject({ kind: z.literal('steer'), ...ActiveTargetFields, text: TextSchema }),
  z.strictObject({ kind: z.literal('queue'), ...ActiveTargetFields, input: MessageInputSchema }),
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
    ]),
  }),
]);
export type IActionCommand = z.infer<typeof ActionCommandSchema>;

// plan scope cannot answer native permission requests or carry filesystem configuration
export const PlanActionScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('execution'),
    authorizationId: z.uuid(),
    milestoneId: z.uuid().nullable(),
    mode: z.enum(['supervised', 'auto']),
    revision: PlanRevisionSchema,
  }),
  z.strictObject({ kind: z.literal('planning'), revisionId: z.uuid(), invocationId: z.uuid() }),
]);
export type IPlanActionScope = z.infer<typeof PlanActionScopeSchema>;
export const ActionPlanContextSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  scope: PlanActionScopeSchema.nullable(),
  observedRevision: PlanRevisionSchema,
});
export type IActionPlanContext = z.infer<typeof ActionPlanContextSchema>;

// identity survives lost client responses; a repeated UUID must carry the same validated request
export const ActionEnvelopeSchema = z
  .strictObject({
    id: z.uuid(),
    runtimeEpoch: z.uuid(),
    command: ActionCommandSchema,
    plan: PlanActionScopeSchema.optional(),
    expectedPlan: ActionPlanContextSchema.nullable().optional(),
  })
  .refine(
    (action) => !('expectedPlan' in action) || ['message', 'queue'].includes(action.command.kind),
  )
  .refine((action) => new TextEncoder().encode(JSON.stringify(action)).length <= 32_768);
export type IActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;

export const ActionReceiptSchema = z.object({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeEpoch: z.uuid(),
  kind: z.enum(ActionCommandSchema.options.map((command) => command.shape.kind.value)),
  threadId: ThreadIdSchema.nullable(),
  nativeTurnId: NativeIdSchema.nullable(),
  nativeRequestId: z.string().nullable(),
  delivery: z.enum(['queued', 'submitted', 'acknowledged', 'uncertain', 'failed', 'canceled']),
  completion: z.enum(['completed', 'failed', 'interrupted']).nullable(),
  failure: z
    .enum(['state-conflict', 'access-denied', 'agent-unavailable', 'operation-failed'])
    .nullable(),
  relatedActionId: z.uuid().nullable(),
  planContext: ActionPlanContextSchema.nullable(),
  queuedText: TextSchema.nullable(),
  queuedSkill: NativeSkillInputSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type IActionReceipt = z.infer<typeof ActionReceiptSchema>;

// collections omit pending message bodies; the selected receipt retains its recoverable text
export const ActionSummarySchema = ActionReceiptSchema.omit({
  queuedText: true,
  queuedSkill: true,
});
export type IActionSummary = z.infer<typeof ActionSummarySchema>;

// control is separate from the native thread's discovery title and historical visibility
export const ManagedThreadSchema = z.object({
  id: ThreadIdSchema,
  provider: z.enum(['codex', 'claude']),
  nativeId: NativeIdSchema.nullable(),
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

// prompts are kept in memory; durable approval records retain identities and response digests
export const NativeApprovalSchema = z.object({
  id: z.uuid(),
  threadId: ThreadIdSchema,
  nativeTurnId: NativeIdSchema,
  runtimeEpoch: z.uuid(),
  kind: z.enum(['command', 'file-change', 'permission', 'question']),
  state: z.enum(['pending', 'answered', 'expired']),
  replyActionId: z.uuid().nullable(),
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
