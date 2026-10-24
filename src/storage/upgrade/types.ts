import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { ErrorKindSchema } from '../../contracts/index.js';

const PathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path) && resolve(path) === path);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

// explicit offline operator inputs; stored workspace roots never grant authority
export const UpgradeOptionsSchema = z.strictObject({
  stateRoot: PathSchema,
  backupDirectory: PathSchema,
  allowedRoots: z.array(PathSchema).min(1).max(128),
  coordinationRoot: PathSchema.optional(),
});
export type IHqStorageUpgradeOptions = z.infer<typeof UpgradeOptionsSchema>;

// current is an idempotent observation, with no new backup or reconciliation
export const UpgradeResultSchema = z.object({
  stateRoot: PathSchema,
  state: z.enum(['upgraded', 'current']),
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  fromSchemaHash: HashSchema,
  toSchemaHash: HashSchema,
  backupDirectory: PathSchema.nullable(),
});
export type IHqStorageUpgradeResult = z.infer<typeof UpgradeResultSchema>;

// the parent pins the key observed before lifetime ownership was acquired
export const UpgradeWorkerInputSchema = UpgradeOptionsSchema.extend({ actionKeyHash: HashSchema });
export const UpgradeWorkerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('result'), result: UpgradeResultSchema }),
  z.object({
    kind: z.literal('error'),
    code: z.string().regex(/^JG_AGENT_HQ_[A-Z_]+$/),
    message: z.string().max(16384),
    cause: z.instanceof(Error).optional(),
    data: z.object({
      kind: ErrorKindSchema,
      phase: z.string().max(64),
      backupDirectory: PathSchema.nullable(),
    }),
  }),
]);
