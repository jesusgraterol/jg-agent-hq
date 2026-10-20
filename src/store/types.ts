import { z } from 'zod';

import { MAX_PAGE_SIZE, ThreadSummarySchema, type IThreadSummary } from '../contracts/index.js';

// worker messages are closed, bounded operations rather than arbitrary SQL
export const StoreCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('remember'),
    threads: z.array(ThreadSummarySchema).max(MAX_PAGE_SIZE),
    nextCursor: z.string().max(16_384).nullable(),
    observedAt: z.number().int(),
  }),
  z.strictObject({ kind: z.literal('close') }),
]);
export type IStoreCommand = z.infer<typeof StoreCommandSchema>;
export const StoreRequestSchema = z.strictObject({
  id: z.number().int(),
  command: StoreCommandSchema,
});
export const StoreResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('result'), id: z.number().int(), error: z.string().nullable() }),
]);
export const StoreWorkerSchema = z.strictObject({
  databasePath: z.string().min(1),
  runtimeEpoch: z.uuid(),
});

// the worker owns persistence; callers cannot submit arbitrary statements
export type IStore = {
  readonly isAvailable: boolean;
  remember(threads: IThreadSummary[], nextCursor: string | null): Promise<void>;
  close(): Promise<void>;
};
