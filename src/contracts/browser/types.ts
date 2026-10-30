import { z } from 'zod';

import {
  ActionEnvelopeSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
} from '../actions/index.js';
import { LiveItemsSchema } from '../types.js';

// the browser surface is closed; hosts resolve every supplied identity against their registry
export const BrowserCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native'), action: ActionEnvelopeSchema }),
]);
export const BrowserActionSchema = z
  .strictObject({
    id: z.uuid(),
    runtimeEpoch: z.uuid(),
    command: BrowserCommandSchema,
  })
  .refine((request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 2_097_152);
export type IBrowserAction = z.infer<typeof BrowserActionSchema>;

// admission and host completion do not imply native turn completion
export const BrowserReceiptSchema = z.object({
  id: z.uuid(),
  runtimeEpoch: z.uuid(),
  kind: z.enum(BrowserCommandSchema.options.map((command) => command.shape.kind.value)),
  state: z.enum(['submitted', 'acknowledged', 'uncertain']),
  nativeActionId: z.uuid(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  native: ActionReceiptSchema.nullable(),
});
export type IBrowserReceipt = z.infer<typeof BrowserReceiptSchema>;

// one managed thread with its pending approvals, live items and recent actions
export const BrowserThreadDetailSchema = z.object({
  thread: ManagedThreadSchema,
  approvals: z.array(NativeApprovalSchema).max(128),
  live: LiveItemsSchema,
  actions: z.object({
    data: z.array(ActionSummarySchema).max(128),
    nextCursor: z.string().nullable(),
  }),
});
