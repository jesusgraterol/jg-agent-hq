import { z } from 'zod';

// singleton identity; an absent version is accepted only for the exact published baseline
export const StorageStampSchema = z.object({
  id: z.literal(1),
  schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  action_key_hash: z.string().regex(/^[a-f0-9]{64}$/),
  schema_version: z.number().int().positive().safe().optional(),
});

// restore support is explicit for every schema; registration alone never permits fencing
export type IStorageSchema = {
  version: number;
  hash: string;
  restoreFenceVersion: number | null;
};

// a fixed directed migration, with no arbitrary SQL supplied by a caller
export type IStorageMigration = { fromVersion: number; toVersion: number; source: URL };
