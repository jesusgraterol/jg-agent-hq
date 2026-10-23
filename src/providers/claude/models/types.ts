import { z } from 'zod';

import { ProviderModelSchema } from '../../../contracts/index.js';

// Claude returns its complete inventory; cap it before application-owned seek paging
export const NativeModelsSchema = z
  .object({
    models: z
      .array(
        z.object({
          value: ProviderModelSchema.shape.id,
          resolvedModel: ProviderModelSchema.shape.model.optional(),
          displayName: ProviderModelSchema.shape.name,
          description: ProviderModelSchema.shape.description,
          supportedEffortLevels: z.array(z.string().min(1).max(64)).max(32).optional(),
        }),
      )
      .max(4096),
  })
  .refine(
    (catalog) => new Set(catalog.models.map((model) => model.value)).size === catalog.models.length,
  )
  .refine((catalog) => Buffer.byteLength(JSON.stringify(catalog)) <= 1_048_576);

// a catalog revision protects keyset continuation when native choices change
export const ModelPositionSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  id: ProviderModelSchema.shape.id,
});
