import { z } from 'zod';

import {
  ActionEnvelopeSchema,
  HandoffSummarySchema,
  HandoffSourceSchema,
  HandoffFindingsSchema,
  HandoffPhaseSchema,
} from '../contracts/index.js';

// persisted intents precede native dispatch, so retries reuse the same action identity
export const HandoffRecordSchema = z.strictObject({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.enum(['challenge', 'review']),
  source: HandoffSourceSchema,
  creation: ActionEnvelopeSchema,
  findings: HandoffFindingsSchema.nullable(),
  createdAt: z.number().int(),
});
export type IHandoffRecord = z.infer<typeof HandoffRecordSchema>;
export const HandoffDispatchSchema = z.strictObject({
  handoffId: z.uuid(),
  phase: HandoffPhaseSchema,
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  destination: HandoffSourceSchema.pick({ threadId: true, nativeId: true, provider: true }),
  action: ActionEnvelopeSchema,
});
export type IHandoffDispatch = z.infer<typeof HandoffDispatchSchema>;
export const HandoffPageRequestSchema = z.strictObject({
  workspaceRoot: z.string(),
  sourceThreadId: z.uuid().optional(),
  limit: z.number().int().min(1).max(128),
  after: z.strictObject({ createdAt: z.number().int(), id: z.uuid() }).optional(),
});
export type IHandoffPageRequest = z.infer<typeof HandoffPageRequestSchema>;
export const HandoffPageSchema = z.object({
  data: z.array(HandoffSummarySchema).max(128),
  hasMore: z.boolean(),
});
