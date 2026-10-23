import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';
import { CursorSchema, NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';

// model and effort identities come from the selected native catalog
export const ProviderModelSchema = z.object({
  id: NativeIdSchema,
  model: NativeIdSchema.nullable(),
  name: z.string().min(1).max(256),
  description: z.string().max(4096),
  efforts: z.array(z.string().min(1).max(64)).max(32).nullable(),
  defaultEffort: z.string().min(1).max(64).nullable(),
  isDefault: z.boolean().nullable(),
});
export type IProviderModel = z.infer<typeof ProviderModelSchema>;

// catalog reads bind continuation to the selected provider and page size
export const ProviderModelsRequestSchema = z.strictObject({
  kind: z.literal('models'),
  provider: ProviderIdSchema,
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: CursorSchema.optional(),
});
export type IProviderModelsRequest = z.infer<typeof ProviderModelsRequestSchema>;

export const ProviderModelPageSchema = z.object({
  provider: ProviderIdSchema,
  data: z.array(ProviderModelSchema).max(MAX_PAGE_SIZE),
  nextCursor: CursorSchema.nullable(),
  source: z.literal('native'),
  observedAt: z.number().int().safe(),
});
export type IProviderModelPage = z.infer<typeof ProviderModelPageSchema>;
