import { z } from 'zod';

import { CursorSchema, NativeIdSchema } from '../../identities/index.js';
import { ProviderIdSchema } from '../../providers/index.js';
import { MAX_RESULT_BYTES } from '../../results/index.js';

import { MAX_REPORT_BYTES } from './constants.js';

// native schemas constrain shape; the collector separately validates binding, UTF-8 and authority
export const DispatchResponseSchema = z
  .strictObject({
    requestId: z.uuid().nullable().meta({
      description:
        'The request ID from hq_invocation_read for active HQ work; null for ordinary conversation.',
    }),
    outcome: z.enum(['completed', 'waiting-children', 'needs-input', 'paused', 'failed']),
    childRequestIds: z.array(z.uuid()).max(32).meta({
      description:
        'Unique direct child requests to await. Nonempty only for waiting-children; retain every unsatisfied dependency from the current wait.',
    }),
    report: z.string().max(MAX_RESULT_BYTES).meta({
      description:
        'The normal Markdown report. Delegated reports must fit 1,048,576 UTF-8 bytes. Only the outermost workflow returns this envelope.',
    }),
    requiredAuthority: z.enum(['requester', 'operator']).nullable().meta({
      description:
        'The authority needed to answer a needs-input checkpoint; null for other outcomes. Completion never grants approval.',
    }),
  })
  .refine(
    (response) => (response.outcome === 'needs-input') === (response.requiredAuthority !== null),
    'Only a needs-input outcome names required authority',
  )
  .refine(
    (response) =>
      (response.outcome === 'waiting-children') === response.childRequestIds.length > 0 &&
      new Set(response.childRequestIds).size === response.childRequestIds.length,
    'Only waiting-children names a nonempty unique child wait set',
  );
export type IDispatchResponse = z.infer<typeof DispatchResponseSchema>;

// both native transports use the same closed object schema, including ordinary null request IDs
const { $schema: _dialect, ...nativeSchema } = z.toJSONSchema(DispatchResponseSchema, {
  io: 'input',
});
export const DISPATCH_OUTPUT_SCHEMA = z.record(z.string(), z.json()).parse(nativeSchema);

// reports retain exact native completion provenance without depending on a transcript item
export const ReportSummarySchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  requestId: z.uuid(),
  actionId: z.uuid(),
  replyMessageId: z.uuid(),
  authorAgentId: z.uuid(),
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
  nativeTurnId: NativeIdSchema,
  outcome: DispatchResponseSchema.shape.outcome,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteCount: z.number().int().min(0).max(MAX_REPORT_BYTES),
  createdAt: z.number().int().nonnegative(),
});
export type IReportSummary = z.infer<typeof ReportSummarySchema>;
export const ReportReadSchema = z.object({
  report: ReportSummarySchema,
  text: z.string(),
  offsetBytes: z.number().int().nonnegative(),
  isComplete: z.boolean(),
  nextCursor: CursorSchema.nullable(),
});
export type IReportRead = z.infer<typeof ReportReadSchema>;
