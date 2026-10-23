import { z } from 'zod';

import {
  CollaborationTaskSchema,
  TaskSummarySchema,
  TaskAgentSchema,
  TaskAgentSummarySchema,
  SkillGrantSchema,
  SkillGrantSummarySchema,
  StreamSchema,
  SubscriptionSchema,
  MessageSummarySchema,
  CollaborationRequestRecordSchema,
  RequestSummarySchema,
  DeliverySchema,
  type ICollaborationTask,
  type ITaskAgent,
  type ISkillGrant,
  type IStream,
  type ISubscription,
  type IMessageSummary,
  type ICollaborationRequestRecord,
  type IRequestSummary,
  type IDelivery,
} from '../../contracts/collaboration/index.js';

const RowSchema = z.record(z.string(), z.unknown());
const jsonColumn = (input: unknown): unknown => JSON.parse(z.string().parse(input));

const taskFields = (row: Record<string, unknown>) => ({
  id: row.id,
  workspaceRoot: row.workspace_root,
  title: row.title,
  ownerOperatorRef: row.owner_operator_ref,
  policyRevision: row.policy_revision,
  state: row.state,
  lifecycleRevision: row.lifecycle_revision,
  createdAt: row.created_at,
});

/** Validates a selected task, including its host policy and optional plan scope. */
export const toTask = (input: unknown): ICollaborationTask => {
  const row = RowSchema.parse(input);
  return CollaborationTaskSchema.parse({
    ...taskFields(row),
    plan: row.plan === null ? null : jsonColumn(row.plan),
    policy: jsonColumn(row.policy),
  });
};

/** Reads a task list row without loading its policy or plan payload. */
export const toTaskSummary = (input: unknown) =>
  TaskSummarySchema.parse(taskFields(RowSchema.parse(input)));

const agentFields = (row: Record<string, unknown>) => ({
  taskId: row.task_id,
  agentId: row.agent_id,
  parentAgentId: row.parent_agent_id,
  role: row.role,
  provider: row.provider,
  workspaceRoot: row.workspace_root,
  revision: row.revision,
  state: row.state,
  isRevoked: z.literal(1).or(z.literal(0)).parse(row.is_revoked) === 1,
  createdAt: row.created_at,
});

/** Validates a membership joined with its existing managed-thread identity. */
export const toTaskAgent = (input: unknown): ITaskAgent => {
  const row = RowSchema.parse(input);
  return TaskAgentSchema.parse({ ...agentFields(row), permissions: jsonColumn(row.permissions) });
};

/** Reads bounded member metadata without hydrating permissions. */
export const toTaskAgentSummary = (input: unknown) =>
  TaskAgentSummarySchema.parse(agentFields(RowSchema.parse(input)));

const grantFields = (row: Record<string, unknown>) => ({
  id: row.id,
  taskId: row.task_id,
  issuerOperatorRef: row.issuer_operator_ref,
  revision: row.revision,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

/** Validates a retained host-issued grant and its exact revocation revision. */
export const toGrant = (input: unknown): ISkillGrant => {
  const row = RowSchema.parse(input);
  return SkillGrantSchema.parse({
    ...grantFields(row),
    eligibleAgentIds: row.eligible_agent_ids === null ? null : jsonColumn(row.eligible_agent_ids),
    skills: jsonColumn(row.skills),
    effects: jsonColumn(row.effects),
    scopes: jsonColumn(row.scopes),
    plan: row.plan === null ? null : jsonColumn(row.plan),
  });
};

/** Reads only indexed grant audit metadata for a list page. */
export const toGrantSummary = (input: unknown) =>
  SkillGrantSummarySchema.parse(grantFields(RowSchema.parse(input)));

/** Validates stream metadata independently of its publications or subscribers. */
export const toStream = (input: unknown): IStream => {
  const row = RowSchema.parse(input);
  return StreamSchema.parse({
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    purpose: row.purpose,
    creator: jsonColumn(row.creator),
    isArchived: z.literal(1).or(z.literal(0)).parse(row.is_archived) === 1,
    createdAt: row.created_at,
  });
};

/** Preserves read position independently of acknowledgements and native delivery. */
export const toSubscription = (input: unknown): ISubscription => {
  const row = RowSchema.parse(input);
  return SubscriptionSchema.parse({
    taskId: row.task_id,
    streamId: row.stream_id,
    agentId: row.agent_id,
    isActive: z.literal(1).or(z.literal(0)).parse(row.is_active) === 1,
    notify: z.literal(1).or(z.literal(0)).parse(row.notify) === 1,
    startingSequence: row.starting_sequence,
    readSequence: row.read_sequence,
    establishedBy: jsonColumn(row.established_by),
    updatedAt: row.updated_at,
  });
};

/** Converts a summary-only SQL projection without reading message bodies or references. */
export const toMessageSummary = (input: unknown): IMessageSummary => {
  const row = RowSchema.parse(input);
  return MessageSummarySchema.parse({
    id: row.id,
    sequence: row.sequence,
    taskId: row.task_id,
    streamId: row.stream_id,
    author: jsonColumn(row.author),
    kind: row.kind,
    summary: row.summary,
    bodyBytes: row.body_bytes,
    referenceCount: row.reference_count,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  });
};

const requestFields = (row: Record<string, unknown>) => ({
  id: row.id,
  taskId: row.task_id,
  streamId: row.stream_id,
  sequence: row.sequence,
  requester: jsonColumn(row.requester),
  assigneeAgentId: row.assignee_agent_id,
  state: row.state,
  currentActionId: row.current_action_id,
  outcome: row.outcome,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Validates a selected request, including its bounded invocation and resolution evidence. */
export const toRequest = (input: unknown): ICollaborationRequestRecord => {
  const row = RowSchema.parse(input);
  return CollaborationRequestRecordSchema.parse({
    ...requestFields(row),
    specification: jsonColumn(row.specification),
    resultReferences: jsonColumn(row.result_references),
  });
};

/** Returns request state without its arguments, path scopes or evidence bodies. */
export const toRequestSummary = (input: unknown): IRequestSummary => {
  const row = RowSchema.parse(input);
  return RequestSummarySchema.parse({
    ...requestFields(row),
    targetAgentId: row.target_agent_id,
    claimable: z.literal(1).or(z.literal(0)).parse(row.is_claimable) === 1,
    skill: row.skill_name === null ? null : { name: row.skill_name, mode: row.skill_mode },
    grantId: row.grant_id,
    grantRevision: row.grant_revision,
  });
};

/** Keeps delivery and explicit acknowledgement as independent durable observations. */
export const toDelivery = (input: unknown): IDelivery => {
  const row = RowSchema.parse(input);
  return DeliverySchema.parse({
    taskId: row.task_id,
    messageId: row.message_id,
    sequence: row.sequence,
    messageSequence: row.message_sequence,
    recipientAgentId: row.recipient_agent_id,
    nativeActionId: row.native_action_id,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
  });
};
