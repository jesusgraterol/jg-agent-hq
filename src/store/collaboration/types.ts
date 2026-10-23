import { z } from 'zod';

import type {
  ICollaborationActor,
  ICollaborationTask,
  ITaskAgent,
  ICollaborationCommand,
} from '../../contracts/collaboration/index.js';

// source positions use immutable sequences and a fixed high-water boundary
export const CollaborationPositionSchema = z
  .strictObject({
    boundary: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
  })
  .refine((position) => position.sequence <= position.boundary);
export type ICollaborationPosition = z.infer<typeof CollaborationPositionSchema>;
export type ICollaborationContext = {
  actor: ICollaborationActor;
  task: ICollaborationTask;
  member: ITaskAgent | null;
};
export type ICollaborationPageEntry = {
  sequence: number;
  item: unknown;
};

// mutation groups share one transaction owner and metadata receipt ledger
export type ITaskMutation = Extract<
  ICollaborationCommand,
  {
    kind:
      | 'task-policy-set'
      | 'task-plan-set'
      | 'task-state-set'
      | 'agent-add'
      | 'agent-policy-set'
      | 'agent-state-set'
      | 'agent-revoke'
      | 'grant-issue'
      | 'grant-revoke';
  }
>;
export type IStreamMutation = Extract<
  ICollaborationCommand,
  { kind: 'stream-create' | 'stream-archive' | 'subscription-set' | 'subscription-advance' }
>;
export type IRequestMutation = Extract<
  ICollaborationCommand,
  {
    kind: 'request-claim' | 'request-resolve' | 'request-cancel' | 'request-reassign';
  }
>;
