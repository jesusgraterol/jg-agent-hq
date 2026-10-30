import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type { IAgentHq } from '../runtime/index.js';
import type { IStore } from '../store/index.js';
import type { createStorage } from '../storage/index.js';

const PathSchema = z.string().min(1).max(4096).refine(isAbsolute);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

// source paths are evidence, never output path components
export const SnapshotHeaderSchema = z.strictObject({
  kind: z.literal('header'),
  format: z.literal(1),
  createdAt: z.iso.datetime(),
  schemaHash: HashSchema,
  packageVersion: z.string().min(1).max(64),
  sourceStateRoot: PathSchema,
  sourceAllowedRoots: z.array(PathSchema).min(1).max(128),
});
export type ISnapshotHeader = z.infer<typeof SnapshotHeaderSchema>;

// the header fields read before its shape, so a snapshot of another schema names its version
export const SnapshotStampSchema = z.object({
  kind: z.literal('header'),
  schemaHash: HashSchema,
  packageVersion: z.string().min(1).max(64),
});

export const SnapshotFileSchema = z.strictObject({
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: HashSchema,
});
export type ISnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotRecordSchema = z.discriminatedUnion('kind', [
  SnapshotHeaderSchema,
  z.strictObject({ kind: z.literal('database'), file: SnapshotFileSchema }),
  z.strictObject({ kind: z.literal('action-key'), file: SnapshotFileSchema }),
]);
export type ISnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

export const SnapshotCompletionSchema = z.strictObject({
  manifestSha256: HashSchema,
  records: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER),
});

export const SnapshotInspectionSchema = z.object({
  directory: PathSchema,
  manifestSha256: HashSchema,
  header: SnapshotHeaderSchema,
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
};

// runtime-private access prevents exposing worker commands or backup paths through RPC
export type ISnapshotContext = {
  runtime: IAgentHq;
  stateRoot: string;
  actionKeyHash: string;
  allowedRoots: string[];
  store: IStore;
  admit: ReturnType<typeof createStorage>['run'];
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
      'JG_AGENT_HQ_STORAGE_INVALID',
    ]),
    message: z.string(),
  }),
]);

// the running runtime supplies its database backup and verification
export type ISnapshotSource = {
  stateRoot: string;
  allowedRoots: string[];
  actionKeyHash: string;
  schemaHash: string;
  backupDatabase: (path: string) => Promise<unknown>;
  verify: (directory: string) => Promise<IHqSnapshotInspection>;
};
