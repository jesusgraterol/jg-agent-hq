import { z } from 'zod';

import { CursorSchema, NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';
import { PlanRevisionSchema } from '../plans/index.js';

// fixed public budgets for durable collaboration content and responses
export const COLLABORATION_LIMITS = {
  summaryBytes: 1024,
  bodyBytes: 8192,
  references: 16,
  responseBytes: 65_536,
  pageDefault: 32,
  pageMaximum: 128,
} as const;

const utf8Text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine((text) => {
      const encoded = new TextEncoder().encode(text);
      return (
        encoded.byteLength <= bytes &&
        new TextDecoder('utf-8', { fatal: true }).decode(encoded) === text
      );
    }, `Text exceeds ${bytes} UTF-8 bytes`);
const boundedJson = (input: unknown, bytes: number): boolean =>
  new TextEncoder().encode(JSON.stringify(input)).byteLength <= bytes;
const UuidSchema = z.uuid();
const RevisionSchema = z.number().int().positive();
const TimeSchema = z.number().int().nonnegative();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const WorkspaceSchema = z.string().min(1).max(4096);
const PageFields = {
  limit: z.number().int().min(1).max(128).default(32),
  cursor: CursorSchema.optional(),
};
const TaskFields = { taskId: UuidSchema };
const OperationFields = { id: UuidSchema, ...TaskFields };

// host actors come only from trusted host APIs; agent tools derive their actor from the session
export const CollaborationActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), operatorRef: utf8Text(256).min(1) }),
  z.object({ kind: z.literal('agent'), agentId: UuidSchema }),
]);
export type ICollaborationActor = z.infer<typeof CollaborationActorSchema>;

// roles are labels; these explicit capabilities and scopes establish admission
export const CollaborationEffectSchema = z.enum([
  'read',
  'planning-write',
  'workspace-write',
  'commit',
  'push',
  'pause',
  'resume',
]);
export const AgentPermissionsSchema = z
  .strictObject({
    providers: z.array(ProviderIdSchema).min(1).max(32),
    workspaceRoots: z.array(WorkspaceSchema).min(1).max(128),
    effects: z.array(CollaborationEffectSchema).min(1).max(7),
    canSpawn: z.boolean(),
    canManagePeerSubscriptions: z.boolean(),
    canExecuteRequests: z.boolean(),
  })
  .refine((policy) => boundedJson(policy, 16_384), 'Agent permissions exceed the metadata budget');
export type IAgentPermissions = z.infer<typeof AgentPermissionsSchema>;
export const TaskPolicySchema = AgentPermissionsSchema.safeExtend({
  automaticDispatch: z.boolean(),
  concurrencyLimit: z.number().int().positive(),
  spawnLimit: z.number().int().nonnegative(),
  automaticTurnLimit: z.number().int().nonnegative(),
});
export type ITaskPolicy = z.infer<typeof TaskPolicySchema>;
export const CollaborationPlanSchema = z.object({
  planId: z.string().min(1).max(128),
  directory: WorkspaceSchema,
  revision: PlanRevisionSchema,
  milestoneIds: z.array(UuidSchema).max(128),
});
export type ICollaborationPlan = z.infer<typeof CollaborationPlanSchema>;
export const PathScopeSchema = z.object({
  workspaceRoot: WorkspaceSchema,
  pathPrefixes: z.array(z.string().max(4096)).min(1).max(128),
});
export type IPathScope = z.infer<typeof PathScopeSchema>;

// references identify evidence without granting access, approval or native tool permissions
export const ArtifactReferenceSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('report'), reportId: UuidSchema, sha256: HashSchema }),
    z
      .strictObject({
        kind: z.literal('repository'),
        workspaceRoot: WorkspaceSchema,
        path: z.string().min(1).max(4096),
        commit: z
          .string()
          .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
          .optional(),
        sha256: HashSchema.optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      })
      .refine(
        (reference) =>
          (reference.commit !== undefined || reference.sha256 !== undefined) &&
          (reference.endLine === undefined ||
            (reference.startLine !== undefined && reference.endLine >= reference.startLine)),
        'Repository evidence requires content identity and a valid line range',
      ),
    z.object({
      kind: z.literal('native'),
      provider: ProviderIdSchema,
      nativeId: NativeIdSchema,
      turnId: NativeIdSchema,
      itemId: NativeIdSchema,
      sha256: HashSchema,
    }),
    z.object({
      kind: z.literal('plan'),
      planId: z.string().min(1).max(128),
      revision: PlanRevisionSchema,
      milestoneId: UuidSchema.nullable(),
    }),
  ])
  .refine(
    (reference) => boundedJson(reference, 16_384),
    'Artifact identity exceeds the reference budget',
  );
export type IArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

// grants select exact skill/mode pairs and never imply later workflow approvals
export const SkillSelectionSchema = z.object({
  name: z.string().min(1).max(128),
  mode: z.string().min(1).max(64).nullable(),
});
const GrantFields = {
  eligibleAgentIds: z.array(UuidSchema).min(1).max(128).nullable(),
  skills: z.array(SkillSelectionSchema).min(1).max(32),
  effects: z.array(CollaborationEffectSchema).min(1).max(7),
  scopes: z.array(PathScopeSchema).min(1).max(16),
  plan: CollaborationPlanSchema.nullable(),
};
export const SkillGrantSchema = z.object({
  id: UuidSchema,
  taskId: UuidSchema,
  issuerOperatorRef: z.string().min(1).max(256),
  revision: RevisionSchema,
  ...GrantFields,
  revokedAt: TimeSchema.nullable(),
  createdAt: TimeSchema,
});
export type ISkillGrant = z.infer<typeof SkillGrantSchema>;
export const RequestSpecificationSchema = z
  .strictObject({
    targetAgentId: UuidSchema.nullable(),
    claimable: z.boolean(),
    skill: SkillSelectionSchema.nullable(),
    grantId: UuidSchema.nullable(),
    grantRevision: RevisionSchema.nullable(),
    arguments: utf8Text(8192),
    effects: z.array(CollaborationEffectSchema).min(1).max(7),
    scopes: z.array(PathScopeSchema).min(1).max(16),
    plan: CollaborationPlanSchema.nullable(),
    targetReferences: z.array(ArtifactReferenceSchema).max(16),
    returnStreamId: UuidSchema.optional(),
  })
  .refine(
    (request) =>
      request.claimable === (request.targetAgentId === null) &&
      (request.skill === null
        ? request.grantId === null && request.grantRevision === null
        : request.grantId !== null && request.grantRevision !== null),
    'Requests require one assignment mode and an exact grant for a selected skill',
  )
  .refine((request) => boundedJson(request, 16_384), 'Request context exceeds the metadata budget');
export type IRequestSpecification = z.infer<typeof RequestSpecificationSchema>;

// lifecycle and read position remain independent of delivery, acknowledgement and resolution
export const CollaborationLifecycleSchema = z.enum(['active', 'paused', 'stopped']);
export const CollaborationTaskSchema = z.object({
  id: UuidSchema,
  workspaceRoot: WorkspaceSchema,
  title: utf8Text(128),
  ownerOperatorRef: z.string().max(256),
  plan: CollaborationPlanSchema.nullable(),
  policy: TaskPolicySchema,
  policyRevision: RevisionSchema,
  spawnCount: z.number().int().nonnegative(),
  state: CollaborationLifecycleSchema,
  lifecycleRevision: RevisionSchema,
  createdAt: TimeSchema,
});
export type ICollaborationTask = z.infer<typeof CollaborationTaskSchema>;
export const TaskAgentSchema = z.object({
  taskId: UuidSchema,
  agentId: UuidSchema,
  parentAgentId: UuidSchema.nullable(),
  role: utf8Text(128).nullable(),
  provider: ProviderIdSchema,
  workspaceRoot: WorkspaceSchema,
  permissions: AgentPermissionsSchema,
  revision: RevisionSchema,
  state: CollaborationLifecycleSchema,
  isRevoked: z.boolean(),
  createdAt: TimeSchema,
});
export type ITaskAgent = z.infer<typeof TaskAgentSchema>;
export const StreamSchema = z.object({
  id: UuidSchema,
  taskId: UuidSchema,
  title: utf8Text(128),
  purpose: utf8Text(1024),
  creator: CollaborationActorSchema,
  isArchived: z.boolean(),
  createdAt: TimeSchema,
});
export type IStream = z.infer<typeof StreamSchema>;
export const SubscriptionSchema = z.object({
  taskId: UuidSchema,
  streamId: UuidSchema,
  agentId: UuidSchema,
  isActive: z.boolean(),
  notify: z.boolean(),
  startingSequence: z.number().int().nonnegative(),
  readSequence: z.number().int().nonnegative(),
  establishedBy: CollaborationActorSchema,
  updatedAt: TimeSchema,
});
export type ISubscription = z.infer<typeof SubscriptionSchema>;
export const MessageSummarySchema = z.object({
  id: UuidSchema,
  sequence: z.number().int().positive(),
  taskId: UuidSchema,
  streamId: UuidSchema,
  author: CollaborationActorSchema,
  kind: z.enum(['information', 'request', 'reply', 'status']),
  summary: utf8Text(1024),
  bodyBytes: z.number().int().min(0).max(8192),
  referenceCount: z.number().int().min(0).max(16),
  replyToMessageId: UuidSchema.nullable(),
  createdAt: TimeSchema,
});
export type IMessageSummary = z.infer<typeof MessageSummarySchema>;
export const MessageReadSchema = z.object({
  message: MessageSummarySchema,
  body: z.string(),
  offsetBytes: z.number().int().nonnegative(),
  bodyComplete: z.boolean(),
  references: z.array(ArtifactReferenceSchema).max(16),
  referenceOffset: z.number().int().min(0).max(16),
  nextCursor: CursorSchema.nullable(),
});
export type IMessageRead = z.infer<typeof MessageReadSchema>;
export const CollaborationRequestRecordSchema = z.object({
  id: UuidSchema,
  taskId: UuidSchema,
  streamId: UuidSchema,
  sequence: z.number().int().positive(),
  requester: CollaborationActorSchema,
  specification: RequestSpecificationSchema,
  assigneeAgentId: UuidSchema.nullable(),
  state: z.enum([
    'open',
    'claimed',
    'waiting-children',
    'waiting-input',
    'interrupted',
    'resolved',
    'canceled',
  ]),
  currentActionId: UuidSchema.nullable(),
  outcome: z.enum(['completed', 'failed']).nullable(),
  resultReferences: z.array(ArtifactReferenceSchema).max(16),
  createdAt: TimeSchema,
  updatedAt: TimeSchema,
});
export type ICollaborationRequestRecord = z.infer<typeof CollaborationRequestRecordSchema>;
export const DeliverySchema = z.object({
  taskId: UuidSchema,
  messageId: UuidSchema,
  sequence: z.number().int().positive(),
  messageSequence: z.number().int().positive(),
  recipientAgentId: UuidSchema,
  nativeActionId: UuidSchema.nullable(),
  deliveredAt: TimeSchema.nullable(),
  acknowledgedAt: TimeSchema.nullable(),
});
export type IDelivery = z.infer<typeof DeliverySchema>;

const PublishSchema = z
  .strictObject({
    kind: z.literal('message-publish'),
    ...OperationFields,
    streamId: UuidSchema,
    messageKind: MessageSummarySchema.shape.kind,
    summary: utf8Text(1024),
    body: utf8Text(8192),
    references: z.array(ArtifactReferenceSchema).max(16),
    replyToMessageId: UuidSchema.nullable(),
    request: RequestSpecificationSchema.nullable(),
  })
  .refine(
    (message) =>
      (message.messageKind === 'request') === (message.request !== null) &&
      (message.messageKind !== 'reply' || message.replyToMessageId !== null),
    'Request and reply publications require their exact relationships',
  );

// commands are metadata-only; native dispatch and host permissions are separate admission paths
export const CollaborationCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task-create'),
    id: UuidSchema,
    workspaceRoot: WorkspaceSchema,
    title: utf8Text(128),
    policy: TaskPolicySchema,
    plan: CollaborationPlanSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('task-read'), ...TaskFields }),
  z.strictObject({ kind: z.literal('tasks-list'), workspaceRoot: WorkspaceSchema, ...PageFields }),
  z.strictObject({
    kind: z.literal('task-policy-set'),
    ...OperationFields,
    expectedRevision: RevisionSchema,
    policy: TaskPolicySchema,
  }),
  z.strictObject({
    kind: z.literal('task-plan-set'),
    ...OperationFields,
    expectedRevision: RevisionSchema,
    plan: CollaborationPlanSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('task-state-set'),
    ...OperationFields,
    expectedRevision: RevisionSchema,
    state: CollaborationLifecycleSchema,
  }),
  z.strictObject({
    kind: z.literal('agent-add'),
    ...OperationFields,
    agentId: UuidSchema,
    parentAgentId: UuidSchema.nullable(),
    role: utf8Text(128).nullable(),
    permissions: AgentPermissionsSchema,
    expectedRevision: RevisionSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('agent-read'), ...TaskFields, agentId: UuidSchema }),
  z.strictObject({ kind: z.literal('agents-list'), ...TaskFields, ...PageFields }),
  z.strictObject({
    kind: z.literal('agent-policy-set'),
    ...OperationFields,
    agentId: UuidSchema,
    expectedRevision: RevisionSchema,
    permissions: AgentPermissionsSchema,
  }),
  z.strictObject({
    kind: z.literal('agent-state-set'),
    ...OperationFields,
    agentId: UuidSchema,
    expectedRevision: RevisionSchema,
    state: CollaborationLifecycleSchema,
  }),
  z.strictObject({
    kind: z.literal('agent-revoke'),
    ...OperationFields,
    agentId: UuidSchema,
    expectedRevision: RevisionSchema,
  }),
  z
    .strictObject({ kind: z.literal('grant-issue'), ...OperationFields, ...GrantFields })
    .refine((grant) => boundedJson(grant, 32_768), 'Grant scope exceeds the metadata budget'),
  z.strictObject({ kind: z.literal('grant-read'), ...TaskFields, grantId: UuidSchema }),
  z.strictObject({ kind: z.literal('grants-list'), ...TaskFields, ...PageFields }),
  z.strictObject({
    kind: z.literal('grant-revoke'),
    ...OperationFields,
    grantId: UuidSchema,
    expectedRevision: RevisionSchema,
  }),
  z.strictObject({
    kind: z.literal('stream-create'),
    ...OperationFields,
    title: utf8Text(128),
    purpose: utf8Text(1024),
  }),
  z.strictObject({ kind: z.literal('stream-read'), ...TaskFields, streamId: UuidSchema }),
  z.strictObject({
    kind: z.literal('streams-list'),
    ...TaskFields,
    isArchived: z.boolean().optional(),
    subscribed: z.literal(true).optional(),
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('stream-archive'),
    ...OperationFields,
    streamId: UuidSchema,
    isArchived: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('subscription-set'),
    ...OperationFields,
    streamId: UuidSchema,
    agentId: UuidSchema,
    isActive: z.boolean(),
    notify: z.boolean(),
    historyLimit: z.number().int().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal('subscription-read'),
    ...TaskFields,
    streamId: UuidSchema,
    agentId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal('subscription-advance'),
    ...OperationFields,
    streamId: UuidSchema,
    throughSequence: z.number().int().nonnegative(),
  }),
  PublishSchema,
  z.strictObject({
    kind: z.literal('messages-list'),
    ...TaskFields,
    streamId: UuidSchema.optional(),
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('messages-search'),
    ...TaskFields,
    streamId: UuidSchema.optional(),
    query: utf8Text(1024).refine((query) => query.trim().length > 0),
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('message-read'),
    ...TaskFields,
    messageId: UuidSchema,
    cursor: CursorSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('message-ack'), ...OperationFields, messageId: UuidSchema }),
  z.strictObject({ kind: z.literal('request-read'), ...TaskFields, requestId: UuidSchema }),
  z.strictObject({
    kind: z.literal('requests-list'),
    ...TaskFields,
    agentId: UuidSchema.optional(),
    state: CollaborationRequestRecordSchema.shape.state.optional(),
    ...PageFields,
  }),
  z.strictObject({ kind: z.literal('request-claim'), ...OperationFields, requestId: UuidSchema }),
  z.strictObject({
    kind: z.literal('request-resolve'),
    ...OperationFields,
    requestId: UuidSchema,
    outcome: z.enum(['completed', 'failed']),
    references: z
      .array(ArtifactReferenceSchema)
      .min(1)
      .max(16)
      .refine(
        (references) => boundedJson(references, 32_768),
        'Resolution evidence exceeds the response budget',
      ),
  }),
  z.strictObject({ kind: z.literal('request-cancel'), ...OperationFields, requestId: UuidSchema }),
  z.strictObject({
    kind: z.literal('request-reassign'),
    ...OperationFields,
    requestId: UuidSchema,
    expectedAssigneeAgentId: UuidSchema.nullable(),
    targetAgentId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal('deliveries-list'),
    ...TaskFields,
    recipientAgentId: UuidSchema.optional(),
    state: z.enum(['unacknowledged', 'undelivered', 'all']).default('unacknowledged'),
    ...PageFields,
  }),
  z.strictObject({ kind: z.literal('status'), ...TaskFields }),
  z.strictObject({ kind: z.literal('fanout-recover'), ...OperationFields }),
  z.strictObject({ kind: z.literal('operation-read'), ...TaskFields, operationId: UuidSchema }),
]);
export type ICollaborationCommand = z.infer<typeof CollaborationCommandSchema>;
export const CollaborationRequestSchema = z
  .strictObject({
    kind: z.literal('collaboration'),
    actor: CollaborationActorSchema,
    command: CollaborationCommandSchema,
  })
  .refine(
    (request) => boundedJson(request, 64_512),
    'Collaboration commands exceed the transport budget',
  );
export type ICollaborationRequest = z.infer<typeof CollaborationRequestSchema>;

// collection rows omit large policy, invocation and body payloads
export const TaskSummarySchema = CollaborationTaskSchema.omit({ policy: true, plan: true });
export const TaskAgentSummarySchema = TaskAgentSchema.omit({ permissions: true });
export const SkillGrantSummarySchema = SkillGrantSchema.pick({
  id: true,
  taskId: true,
  issuerOperatorRef: true,
  revision: true,
  revokedAt: true,
  createdAt: true,
});
export const RequestSummarySchema = CollaborationRequestRecordSchema.omit({
  specification: true,
  resultReferences: true,
}).extend({
  targetAgentId: UuidSchema.nullable(),
  claimable: z.boolean(),
  skill: SkillSelectionSchema.nullable(),
  grantId: UuidSchema.nullable(),
  grantRevision: RevisionSchema.nullable(),
});
export type IRequestSummary = z.infer<typeof RequestSummarySchema>;

const PageResultFields = { nextCursor: CursorSchema.nullable() };
const CountSchema = z.object({ count: z.number().int().min(0).max(128), hasMore: z.boolean() });
export const CollaborationStatusSchema = z.object({
  taskId: UuidSchema,
  state: CollaborationLifecycleSchema,
  policyRevision: RevisionSchema,
  lifecycleRevision: RevisionSchema,
  pendingRequests: CountSchema,
  pendingDeliveries: CountSchema,
  unacknowledgedDeliveries: CountSchema,
  pendingFanout: CountSchema,
  fanoutFailure: z.enum(['JG_AGENT_HQ_STORE_FAILED']).nullable(),
});
export type ICollaborationStatus = z.infer<typeof CollaborationStatusSchema>;

// these results describe committed metadata, never acceptance by a native agent
export const CollaborationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), task: CollaborationTaskSchema }),
  z.object({
    kind: z.literal('tasks'),
    data: z.array(TaskSummarySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('agent'), agent: TaskAgentSchema }),
  z.object({
    kind: z.literal('agents'),
    data: z.array(TaskAgentSummarySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('grant'), grant: SkillGrantSchema }),
  z.object({
    kind: z.literal('grants'),
    data: z.array(SkillGrantSummarySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('stream'), stream: StreamSchema }),
  z.object({
    kind: z.literal('streams'),
    data: z.array(StreamSchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('subscription'), subscription: SubscriptionSchema.nullable() }),
  z.object({
    kind: z.literal('publication'),
    message: MessageSummarySchema,
    request: RequestSummarySchema.nullable(),
  }),
  z.object({
    kind: z.literal('messages'),
    data: z.array(MessageSummarySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('message'), result: MessageReadSchema }),
  z.object({ kind: z.literal('request'), request: CollaborationRequestRecordSchema }),
  z.object({
    kind: z.literal('requests'),
    data: z.array(RequestSummarySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('delivery'), delivery: DeliverySchema }),
  z.object({
    kind: z.literal('deliveries'),
    data: z.array(DeliverySchema).max(128),
    ...PageResultFields,
  }),
  z.object({ kind: z.literal('status'), status: CollaborationStatusSchema }),
  z.object({ kind: z.literal('fanout'), taskId: UuidSchema, scheduled: z.literal(true) }),
]);
export type ICollaborationResult = z.infer<typeof CollaborationResultSchema>;

// a metadata receipt is independent of the native action ledger and retains the original result
export const CollaborationOperationSchema = z.object({
  id: UuidSchema,
  taskId: UuidSchema,
  actor: CollaborationActorSchema,
  commandKind: z.string(),
  digest: HashSchema,
  result: CollaborationResultSchema,
  createdAt: TimeSchema,
});
export type ICollaborationOperation = z.infer<typeof CollaborationOperationSchema>;
export const CollaborationResponseSchema = z.union([
  CollaborationResultSchema,
  z.object({ kind: z.literal('operation'), operation: CollaborationOperationSchema.nullable() }),
]);
export type ICollaborationResponse = z.infer<typeof CollaborationResponseSchema>;
