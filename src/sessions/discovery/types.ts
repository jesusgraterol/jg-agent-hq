import { z } from 'zod';

import {
  MAX_WORKSPACE_ROOTS,
  ProviderIdSchema,
  type IThreadSummary,
} from '../../contracts/index.js';
import { NativeIdSchema } from '../../contracts/identities/index.js';
import type { IThreadList } from '../../providers/index.js';

// a session's place in a list: last activity, then provider, then native ID, each descending
export const ListKeySchema = z.strictObject({
  updatedAt: z.number().int(),
  provider: ProviderIdSchema,
  nativeId: NativeIdSchema,
});
export type IListKey = z.infer<typeof ListKeySchema>;

/*
 * Where one source stands once a page ends: null when it has nothing left to list, otherwise the
 * latest activity its unlisted sessions can have, and the continuation of the earliest native page
 * that holds them, null for its first page.
 */
export const SourceStateSchema = z
  .tuple([z.number().int().nonnegative(), z.string().min(1).max(8192).nullable()])
  .nullable();
export type ISourceState = z.infer<typeof SourceStateSchema>;

// where a `threads` read continues: its last session and each folder and provider's state
export const DiscoveryPositionSchema = z.strictObject({
  last: ListKeySchema,
  sources: z.array(SourceStateSchema).max(MAX_WORKSPACE_ROOTS * ProviderIdSchema.options.length),
});
export type IDiscoveryPosition = z.infer<typeof DiscoveryPositionSchema>;

// one source a page merges: its state, and how it reads the native page a continuation starts
export type IMergeSource = {
  // sources of one lane, such as one provider's, are read one at a time
  lane: string;
  // whether it reads its sessions in the list's own order, ties included, as HQ's indexes do
  isOrdered: boolean;
  state: ISourceState;
  read(cursor: string | null): Promise<IThreadList>;
};

export type IMergeOptions = {
  sources: IMergeSource[];
  limit: number;
  // the last session the pages before listed, or null for a first page
  last: IListKey | null;
  // ends the page's reads; a source it stops is left out of the page
  signal: AbortSignal;
  // whether a session belongs in the list, such as one whose chat continues elsewhere
  isListed(summary: IThreadSummary): boolean;
};

/*
 * A merged page: its sessions, the last one consumed, each source's state and the sources left
 * out because their provider was unavailable or the page's time ran out.
 */
export type IMergeResult = {
  data: IThreadSummary[];
  last: IListKey | null;
  states: ISourceState[];
  unavailable: number[];
  hasMore: boolean;
};
