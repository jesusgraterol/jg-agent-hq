import { z } from 'zod';

import { NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';

// the live state shared by managed sessions and sessions another client drives
export const SessionStateSchema = z.enum([
  'running',
  'waiting',
  'idle',
  'closed',
  'failed',
  'unknown',
]);
export type ISessionState = z.infer<typeof SessionStateSchema>;

// why a session entered its new state
export const SessionTransitionReasonSchema = z.enum([
  'opened',
  'turn-started',
  'turn-completed',
  'waiting-for-input',
  'operator-stopped',
  'failed',
  'disappeared',
  'closed',
]);
export type ISessionTransitionReason = z.infer<typeof SessionTransitionReasonSchema>;

/*
 * One recorded state change, in sequence order. A managed session carries its HQ thread ID and
 * may have no native ID while it is created; an observed session has only its native identity.
 */
export const SessionTransitionSchema = z.object({
  sequence: z.number().int().positive(),
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema.nullable(),
  threadId: z.uuid().nullable(),
  ownership: z.enum(['external', 'managed', 'uncertain']),
  previousState: SessionStateSchema.nullable(),
  state: SessionStateSchema,
  reason: SessionTransitionReasonSchema,
  recordedAt: z.number().int(),
});
export type ISessionTransition = z.infer<typeof SessionTransitionSchema>;

// transitions after a sequence cursor; continue with the last returned sequence
export const SessionTransitionPageSchema = z.object({
  data: z.array(SessionTransitionSchema).max(128),
  hasMore: z.boolean(),
});
