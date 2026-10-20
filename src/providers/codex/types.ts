import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  type IHistoryItem,
  type IThreadSummary,
  type ITurnSummary,
  type IUsageSnapshot,
} from '../../contracts/index.js';

// additive native responses are narrowed to fields this adapter actually uses
export const NativeThreadSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().nullable().optional(),
  createdAt: z.number().int().safe(),
  updatedAt: z.number().int().safe(),
  status: z.object({ type: z.enum(['notLoaded', 'idle', 'systemError', 'active']) }),
});
export const NativeTurnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  startedAt: z.number().int().safe().nullable().optional(),
  completedAt: z.number().int().safe().nullable().optional(),
});
export const NativeItemSchema = z.object({
  turnId: z.string().min(1),
  item: z.object({ id: z.string().min(1), type: z.string() }).catchall(z.unknown()),
});
export const NativeThreadPageSchema = z.object({
  data: z.array(NativeThreadSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
export const NativeTurnPageSchema = z.object({
  data: z.array(NativeTurnSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
export const NativeItemPageSchema = z.object({
  data: z.array(NativeItemSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
const NativeWindowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().safe().nullable().optional(),
});
export const NativeBucketSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: NativeWindowSchema.nullable().optional(),
  secondary: NativeWindowSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
});
export const NativeUsageSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), NativeBucketSchema).nullable(),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
});

export type INativeThread = z.infer<typeof NativeThreadSchema>;
export type INativeTurn = z.infer<typeof NativeTurnSchema>;
export type INativeItem = z.infer<typeof NativeItemSchema>;
export type INativeUsage = z.infer<typeof NativeUsageSchema>;
export type INativePage<T> = { data: T[]; nextCursor: string | null };

// all conversation bodies stay native; this adapter returns bounded read models
export type ICodexProvider = {
  userAgent: string;
  readonly isAvailable: boolean;
  listThreads(
    workspaceRoot: string,
    limit: number,
    cursor?: string,
    search?: string,
  ): Promise<INativePage<IThreadSummary>>;
  readThread(nativeId: string): Promise<IThreadSummary>;
  listTurns(nativeId: string, limit: number, cursor?: string): Promise<INativePage<ITurnSummary>>;
  listItems(
    nativeId: string,
    limit: number,
    cursor?: string,
    turnId?: string,
  ): Promise<INativePage<IHistoryItem>>;
  readUsage(): Promise<IUsageSnapshot>;
  close(): Promise<void>;
};
