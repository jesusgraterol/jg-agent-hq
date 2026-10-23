import { z } from 'zod';

import { MAX_PAGE_SIZE, ProviderModelSchema } from '../../../contracts/index.js';

// only consumed model metadata is validated; additive native fields remain compatible
export const NativeModelsSchema = z.object({
  data: z
    .array(
      z.object({
        id: ProviderModelSchema.shape.id,
        model: ProviderModelSchema.shape.model.unwrap(),
        displayName: ProviderModelSchema.shape.name,
        description: ProviderModelSchema.shape.description,
        supportedReasoningEfforts: z
          .array(z.object({ reasoningEffort: z.string().min(1).max(64) }))
          .max(32),
        defaultReasoningEffort: z.string().min(1).max(64),
        isDefault: z.boolean(),
      }),
    )
    .max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
