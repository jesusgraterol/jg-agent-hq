import { z } from 'zod';

import {
  RequestSpecificationSchema,
  CollaborationActorSchema,
  CollaborationRequestRecordSchema,
  CollaborationTaskSchema,
  TaskAgentSchema,
  DispatchBlockedSchema,
} from '../../contracts/collaboration/index.js';
import { ManagedThreadSchema } from '../../contracts/actions/index.js';

// private selectors accompany the native action; models cannot supply admission authority
export const DispatchAdmissionSchema = z.strictObject({
  taskId: z.uuid(),
  requestId: z.uuid(),
  pendingActionId: z.uuid(),
});
export type IDispatchAdmission = z.infer<typeof DispatchAdmissionSchema>;
export const DispatchContextSchema = DispatchAdmissionSchema.extend({
  agentId: z.uuid(),
  specification: RequestSpecificationSchema,
  requester: CollaborationActorSchema,
  inputMessageId: z.uuid().nullable(),
  isAutomatic: z.boolean(),
  replyMessageId: z.uuid(),
  interruptActionId: z.uuid(),
  packet: z.string().max(65_536),
  provider: ManagedThreadSchema.shape.provider,
  nativeId: ManagedThreadSchema.shape.nativeId.unwrap(),
  runtimeEpoch: z.uuid(),
});
export type IDispatchContext = z.infer<typeof DispatchContextSchema>;

// bounded recovery uses ascending immutable request sequences, without reading report bodies
export const DispatchScanSchema = z.strictObject({
  after: z.number().int().nonnegative(),
  boundary: z.number().int().nonnegative().optional(),
});
export type IDispatchScan = z.infer<typeof DispatchScanSchema>;
export const DispatchPageSchema = z.object({
  data: z
    .array(
      z.object({ taskId: z.uuid(), requestId: z.uuid(), sequence: z.number().int().positive() }),
    )
    .max(32),
  boundary: z.number().int().nonnegative(),
});
export type IDispatchPage = z.infer<typeof DispatchPageSchema>;
export const DispatchJobSchema = z.object({
  request: CollaborationRequestRecordSchema,
  task: CollaborationTaskSchema,
  member: TaskAgentSchema.nullable(),
  thread: ManagedThreadSchema.nullable(),
  context: DispatchContextSchema.nullable(),
  packet: z.string().nullable(),
  blockedReason: DispatchBlockedSchema.nullable(),
});
export type IDispatchJob = z.infer<typeof DispatchJobSchema>;
