import { z } from 'zod';

// singleton identity of the schema, the action key and the package version that wrote them
export const StorageStampSchema = z.object({
  id: z.literal(1),
  schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  action_key_hash: z.string().regex(/^[a-f0-9]{64}$/),
  package_version: z.string().min(1).max(64),
});
