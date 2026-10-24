import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type { IAgentHq } from '../runtime/index.js';
import type { IStore } from '../store/index.js';
import type { createStorage } from '../storage/index.js';

const PathSchema = z.string().min(1).max(4096).refine(isAbsolute);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

// one streamed inventory format; source paths are evidence, never output path components
export const SnapshotHeaderSchema = z.strictObject({
  kind: z.literal('header'),
  format: z.literal(1),
  createdAt: z.iso.datetime(),
  schemaHash: HashSchema,
  sourceStateRoot: PathSchema,
  sourceCoordinationRoot: PathSchema,
  sourceAllowedRoots: z.array(PathSchema).min(1).max(128),
});
export type ISnapshotHeader = z.infer<typeof SnapshotHeaderSchema>;

export const SnapshotFileSchema = z.strictObject({
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: HashSchema,
});
export type ISnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotPlanSchema = z.strictObject({
  kind: z.literal('plan'),
  key: HashSchema,
  sourceDirectory: PathSchema,
  planId: z.string().max(4096).nullable(),
  revision: z.number().int().nonnegative().nullable(),
  plan: SnapshotFileSchema.nullable(),
  milestones: SnapshotFileSchema.nullable(),
  coordination: SnapshotFileSchema.nullable(),
  diagnostics: z
    .array(z.enum(['plan-missing', 'plan-unavailable', 'plan-diagnostics', 'coordination-invalid']))
    .max(3),
});
export type ISnapshotPlan = z.infer<typeof SnapshotPlanSchema>;

export const SnapshotRecordSchema = z.discriminatedUnion('kind', [
  SnapshotHeaderSchema,
  z.strictObject({ kind: z.literal('database'), file: SnapshotFileSchema }),
  z.strictObject({ kind: z.literal('action-key'), file: SnapshotFileSchema }),
  SnapshotPlanSchema,
]);
export type ISnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

export const SnapshotCompletionSchema = z.strictObject({
  manifestSha256: HashSchema,
  records: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER),
});

// inspection returns bounded metadata, never the complete growing plan inventory
export const SnapshotInspectionSchema = z.object({
  directory: PathSchema,
  manifestSha256: HashSchema,
  header: SnapshotHeaderSchema,
  planCount: z.number().int().nonnegative(),
  diagnosticPlanCount: z.number().int().nonnegative(),
  pendingWriteCount: z.number().int().nonnegative(),
});
export type IHqSnapshotInspection = z.infer<typeof SnapshotInspectionSchema>;

export const RestoreOptionsSchema = z.strictObject({
  snapshotDirectory: PathSchema,
  destination: PathSchema,
});
export type IHqRestoreOptions = z.infer<typeof RestoreOptionsSchema>;

// source bindings remain inspectable; the host explicitly supplies roots to createAgentHq
export type IHqRestoreResult = IHqSnapshotInspection & {
  stateRoot: string;
  recoveryRoot: string;
};

// runtime-private access prevents exposing worker commands or backup paths through RPC
export type ISnapshotContext = {
  runtime: IAgentHq;
  stateRoot: string;
  actionKeyHash: string;
  coordinationRoot: string;
  allowedRoots: string[];
  store: IStore;
  maintenance: ReturnType<typeof createStorage>['withStorageMaintenance'];
  isClosing: () => boolean;
};

export const SnapshotWorkerInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspect'), directory: PathSchema }),
  z.strictObject({ kind: z.literal('restore'), directory: PathSchema, destination: PathSchema }),
]);

export const SnapshotWorkerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('result'), result: SnapshotInspectionSchema }),
  z.object({
    kind: z.literal('error'),
    code: z.enum([
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
      'JG_AGENT_HQ_SNAPSHOT_FAILED',
      'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED',
    ]),
    message: z.string(),
  }),
]);

// both runtime and offline maintenance supply real backup and keyset-page operations
export type ISnapshotSource = {
  stateRoot: string;
  coordinationRoot: string;
  allowedRoots: string[];
  actionKeyHash: string;
  schemaHash: string;
  backupDatabase: (path: string) => Promise<unknown>;
  readPlans: (after: string) => Promise<string[]>;
  verify: (directory: string) => Promise<IHqSnapshotInspection>;
};
