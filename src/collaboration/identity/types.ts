import { z } from 'zod';
import { isAbsolute } from 'node:path';

import { ProviderIdSchema } from '../../contracts/providers/index.js';
import { NativeIdSchema, CursorSchema } from '../../contracts/identities/index.js';
import { AgentIdentityArgumentsSchema } from '../../contracts/agent-tools/index.js';
import {
  AgentPermissionsSchema,
  TaskAgentSummarySchema,
  TaskSummarySchema,
  MessageSummarySchema,
  CollaborationEffectSchema,
  DispatchBlockedSchema,
} from '../../contracts/collaboration/index.js';

// only the owning provider connection or verified private bridge supplies this proof
export const NativeToolBindingSchema = z.strictObject({
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
  runtimeEpoch: z.uuid(),
  turnId: NativeIdSchema.optional(),
});
export type INativeToolBinding = z.infer<typeof NativeToolBindingSchema>;

// task selection is a query selector; current membership remains the authority
export const AgentIdentityQuerySchema = z.strictObject({
  binding: NativeToolBindingSchema,
  ...AgentIdentityArgumentsSchema.shape,
});
export type IAgentIdentityQuery = z.infer<typeof AgentIdentityQuerySchema>;

// effective intersections may be empty after the host narrows a policy
const EffectivePermissionsSchema = z.object({
  ...AgentPermissionsSchema.shape,
  providers: z.array(ProviderIdSchema).max(32),
  workspaceRoots: z.array(z.string().min(1).max(4096)).max(128),
  effects: z.array(CollaborationEffectSchema).max(7),
});

// compact identity and task discovery omit invocation bodies and full task policies
export const AgentIdentitySchema = z.object({
  agentId: z.uuid(),
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
  workspaceRoot: z.string(),
  runtimeEpoch: z.uuid(),
  selectedTask: TaskSummarySchema.nullable(),
  membership: TaskAgentSummarySchema.nullable(),
  purpose: MessageSummarySchema.shape.summary.nullable(),
  permissions: EffectivePermissionsSchema.nullable(),
  invocation: z
    .object({
      requestId: z.uuid(),
      actionId: z.uuid(),
      taskId: z.uuid(),
      blockedReason: DispatchBlockedSchema.nullable(),
    })
    .nullable(),
  waiting: z.object({
    requests: z
      .array(
        z.object({
          requestId: z.uuid(),
          taskId: z.uuid(),
          waitGeneration: z.number().int().positive(),
          childCount: z.number().int().min(1).max(32),
          continuationActionId: z.uuid().nullable(),
        }),
      )
      .max(32),
    hasMore: z.boolean(),
  }),
  tasks: z.array(TaskSummarySchema).max(128),
  nextCursor: CursorSchema.nullable(),
});
export type IAgentIdentity = z.infer<typeof AgentIdentitySchema>;

// this server-only context accompanies admission and never appears in model arguments
export const AgentSpawnAdmissionSchema = z.strictObject({
  binding: NativeToolBindingSchema,
  taskId: z.uuid(),
  purpose: MessageSummarySchema.shape.summary.min(1),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IAgentSpawnAdmission = z.infer<typeof AgentSpawnAdmissionSchema>;

export const AgentSpawnReadSchema = z.strictObject({
  binding: NativeToolBindingSchema,
  taskId: z.uuid(),
  actionId: z.uuid(),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IAgentSpawnRead = z.infer<typeof AgentSpawnReadSchema>;
export const AgentSpawnRecordSchema = z.object({
  actionId: z.uuid(),
  taskId: z.uuid(),
  parentAgentId: z.uuid(),
  childAgentId: z.uuid().nullable(),
  purpose: MessageSummarySchema.shape.summary,
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
});
export type IAgentSpawnRecord = z.infer<typeof AgentSpawnRecordSchema>;

// private transport material is never part of model arguments or persisted collaboration records
export const BridgeCredentialSchema = z.strictObject({
  stateRoot: z.string().min(1).max(4096).refine(isAbsolute),
  runtimeEpoch: z.uuid(),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IBridgeCredential = z.infer<typeof BridgeCredentialSchema>;
export type IAgentCredentialLease = { filePath: string; release(): Promise<void> };
