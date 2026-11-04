import { abortable } from 'jg-utilities';

import type { IThreadSummary } from '../../contracts/index.js';
import { getErrorKind } from '../../errors/index.js';

import type { IListKey, IMergeOptions, IMergeResult, ISourceState } from './types.js';
import { compareListKeys, toListKey } from './utilities.js';

// a session a source read and the page no session has listed yet, by the continuation it came from
type IEntry = { summary: IThreadSummary; source: number; page: number; start: string | null };

/*
 * How far one source has been read during a page: the latest activity its unread sessions can
 * have, the last session it read, the continuation it reads from next and how many pages it read.
 */
type IProgress = {
  bound: number;
  lastRead: IListKey | null;
  cursor: string | null;
  pages: number;
  isDone: boolean;
  isUnavailable: boolean;
};

/**
 * Merges sources' sessions into one page in list order, reading each source only as far as the
 * page needs: a session is listed once no source still holding unread sessions can hold one
 * before it. A native list such as Codex's sorts by last activity alone and breaks ties its own
 * way, so it must have read past the session's activity time; a source that reads in the list's
 * own order, as HQ's indexes do, only past the session itself. Each source resumes from the
 * continuation of the earliest native page holding sessions the page didn't list, so a later page
 * re-reads at most that one page of it, and skips what the pages before listed. A read whose
 * provider is unavailable, or that the signal stops, leaves its source out of the page.
 * @param options The sources, page size, last session listed before, signal and list filter.
 * @returns The page, where each source stands, the sources left out and whether more remain.
 * @throws Any read failure whose provider isn't unavailable.
 */
export const mergeSources = async ({
  sources,
  limit,
  last,
  signal,
  isListed,
}: IMergeOptions): Promise<IMergeResult> => {
  const progress: IProgress[] = sources.map(({ state }) => ({
    bound: state?.[0] ?? 0,
    lastRead: null,
    cursor: state?.[1] ?? null,
    pages: 0,
    isDone: state === null,
    isUnavailable: false,
  }));
  let entries: IEntry[] = [];
  let isSorted = true;
  let position = last;
  const data: IThreadSummary[] = [];
  const listed = new Set<string>();

  // reads a source's next native page, keeping the sessions after the page's position
  const read = async (index: number): Promise<void> => {
    const state = progress[index]!;
    const start = state.cursor;
    try {
      signal.throwIfAborted();
      const page = await abortable(sources[index]!.read(start), { signal });
      state.pages += 1;
      for (const summary of page.data)
        if ((!position || compareListKeys(summary, position) > 0) && isListed(summary))
          entries.push({ summary, source: index, page: state.pages, start });
      const lastRead = page.data.at(-1);
      if (lastRead) {
        state.bound = Math.min(state.bound, lastRead.updatedAt);
        state.lastRead = toListKey(lastRead);
      }
      state.cursor = page.nextCursor;
      state.isDone = page.nextCursor === null;
      isSorted = false;
    } catch (error) {
      if (!signal.aborted && getErrorKind(error) !== 'agent-unavailable') throw error;
      state.isUnavailable = true;
      entries = entries.filter((entry) => entry.source !== index);
    }
  };

  // reads each source once, one lane's sources at a time and the lanes together
  const readAll = async (indexes: number[]): Promise<void> => {
    const lanes = new Map<string, number[]>();
    for (const index of indexes)
      lanes.set(sources[index]!.lane, [...(lanes.get(sources[index]!.lane) ?? []), index]);
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const index of lane) await read(index);
      }),
    );
  };

  while (data.length < limit) {
    if (!isSorted) {
      entries.sort((left, right) => compareListKeys(left.summary, right.summary));
      isSorted = true;
    }
    const next = entries[0];
    const open = progress.flatMap((state, index) =>
      state.isDone || state.isUnavailable ? [] : [index],
    );
    // without a session to list, the sources whose unread sessions can be the latest are read
    const threshold = next?.summary.updatedAt ?? Math.max(...open.map((i) => progress[i]!.bound));
    const blocking = open.filter((index) => {
      const { bound, lastRead } = progress[index]!;
      return next && lastRead && sources[index]!.isOrdered
        ? compareListKeys(next.summary, lastRead) > 0
        : bound >= threshold;
    });
    if (blocking.length > 0) {
      await readAll(blocking);
      continue;
    }
    if (!next) break;
    entries.shift();
    position = toListKey(next.summary);
    // a session HQ created can show in a native list as its first turn starts, listed once
    const identity = JSON.stringify([next.summary.provider, next.summary.nativeId]);
    if (listed.has(identity)) continue;
    listed.add(identity);
    data.push(next.summary);
  }

  const states = progress.map((state, index): ISourceState => {
    if (state.isUnavailable) return null;
    const unlisted = entries.filter((entry) => entry.source === index);
    if (unlisted.length === 0) return state.isDone ? null : [state.bound, state.cursor];
    const earliest = unlisted.reduce((first, entry) => (entry.page < first.page ? entry : first));
    return [Math.max(...unlisted.map((entry) => entry.summary.updatedAt)), earliest.start];
  });
  return {
    data,
    last: position,
    states,
    unavailable: progress.flatMap((state, index) => (state.isUnavailable ? [index] : [])),
    hasMore: states.some((state) => state !== null),
  };
};
