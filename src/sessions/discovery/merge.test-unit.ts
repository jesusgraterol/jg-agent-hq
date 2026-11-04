import { Exception } from 'jg-exception';
import { expect, test } from 'vitest';

import type { IProviderId, IThreadSummary } from '../../contracts/index.js';

import { FIRST_READ } from './constants.js';
import { mergeSources } from './merge.js';
import type { IListKey, IMergeSource, ISourceState } from './types.js';

// a session with only the fields a list orders and filters by set
const session = (
  provider: IProviderId,
  nativeId: string,
  updatedAt: number,
  continuedIn: string | null = null,
): IThreadSummary => ({
  provider,
  nativeId,
  nativeLineage: null,
  workspaceRoot: '/workspace',
  name: null,
  createdAt: updatedAt,
  updatedAt,
  nativeState: 'unknown',
  state: 'unknown',
  ownership: 'external',
  managedId: null,
  historyState: 'available',
  terminal: null,
  backgroundCommands: 0,
  continuedIn,
});

/*
 * A source that lists its sessions in the given order, `size` a native page, whose continuation
 * is the index its next page starts at, and that records the continuation of every read.
 */
const source = (
  lane: string,
  isOrdered: boolean,
  sessions: IThreadSummary[],
  size: number,
): IMergeSource & { reads: (string | null)[] } => {
  const reads: (string | null)[] = [];
  return {
    lane,
    isOrdered,
    state: FIRST_READ,
    reads,
    async read(cursor) {
      reads.push(cursor);
      const start = cursor === null ? 0 : Number(cursor);
      return {
        data: sessions.slice(start, start + size),
        nextCursor: start + size < sessions.length ? String(start + size) : null,
      };
    },
  };
};

// reads every page of a list, each continuing from where the one before left its sources
const listAll = async (
  sources: IMergeSource[],
  limit: number,
  isListed: (summary: IThreadSummary) => boolean = () => true,
): Promise<string[][]> => {
  const pages: string[][] = [];
  let last: IListKey | null = null;
  let states: ISourceState[] = sources.map(() => FIRST_READ);
  for (;;) {
    const page = await mergeSources({
      sources: sources.map((entry, index) => ({ ...entry, state: states[index]! })),
      limit,
      last,
      signal: new AbortController().signal,
      isListed,
    });
    pages.push(page.data.map((summary) => summary.nativeId));
    if (!page.hasMore) return pages;
    expect(page.data).toHaveLength(limit);
    ({ last, states } = page);
  }
};

test('sessions list newest first, ties by provider then native ID descending, across pages without duplicates or gaps', async () => {
  // Codex breaks its ties by ascending ID, the opposite of the list
  const codex = source(
    'codex',
    false,
    [
      session('codex', 'a', 300),
      session('codex', 'b', 300),
      session('codex', 'c', 300),
      session('codex', 'd', 200),
      session('codex', 'e', 100),
    ],
    2,
  );
  const claude = source(
    'claude',
    true,
    [session('claude', 'z', 300), session('claude', 'y', 200), session('claude', 'x', 200)],
    2,
  );
  expect(await listAll([codex, claude], 2)).toStrictEqual([
    ['c', 'b'],
    ['a', 'z'],
    ['d', 'y'],
    ['x', 'e'],
  ]);
});

test('a page reads each source only past what it lists, and a later page resumes from the native page holding its next session', async () => {
  const newer = source(
    'codex',
    false,
    Array.from({ length: 6 }, (_, index) => session('codex', `newer-${index}`, 900 - index)),
    3,
  );
  const older = source(
    'claude',
    true,
    Array.from({ length: 6 }, (_, index) => session('claude', `older-${index}`, 100 - index)),
    3,
  );
  const first = await mergeSources({
    sources: [newer, older],
    limit: 4,
    last: null,
    signal: new AbortController().signal,
    isListed: () => true,
  });
  expect(first.data.map((summary) => summary.nativeId)).toStrictEqual([
    'newer-0',
    'newer-1',
    'newer-2',
    'newer-3',
  ]);
  // the newer source's next sessions are on its second native page, and the older one is unlisted
  expect(first.states).toStrictEqual([
    [896, '3'],
    [100, null],
  ]);
  newer.reads.length = 0;
  older.reads.length = 0;
  const second = await mergeSources({
    sources: [
      { ...newer, state: first.states[0]! },
      { ...older, state: first.states[1]! },
    ],
    limit: 2,
    last: first.last,
    signal: new AbortController().signal,
    isListed: () => true,
  });
  expect(second.data.map((summary) => summary.nativeId)).toStrictEqual(['newer-4', 'newer-5']);
  // the second page re-reads only the native page holding the next session; the older isn't read
  expect(newer.reads).toStrictEqual(['3']);
  expect(older.reads).toStrictEqual([]);
  expect(second.states).toStrictEqual([null, [100, null]]);
});

test('sessions the list leaves out never count toward a page, and a session two sources list shows once', async () => {
  const native = source(
    'codex',
    false,
    [
      session('codex', 'moved-1', 500, 'next'),
      session('codex', 'shared', 400),
      session('codex', 'moved-2', 300, 'next'),
      session('codex', 'kept', 200),
    ],
    1,
  );
  const records = source('hq', true, [session('codex', 'shared', 450)], 4);
  expect(
    await listAll([native, records], 2, (summary) => summary.continuedIn === null),
  ).toStrictEqual([['shared', 'kept']]);
});

test('a source whose provider is unavailable is left out with what it read, while other failures fail the page', async () => {
  const listed = source('claude', true, [session('claude', 'kept', 100)], 4);
  const failing: IMergeSource = {
    lane: 'codex',
    isOrdered: false,
    state: FIRST_READ,
    read: () =>
      Promise.reject(
        new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: { kind: 'agent-unavailable' },
        }),
      ),
  };
  const page = await mergeSources({
    sources: [failing, listed],
    limit: 4,
    last: null,
    signal: new AbortController().signal,
    isListed: () => true,
  });
  expect(page).toMatchObject({ unavailable: [0], states: [null, null], hasMore: false });
  expect(page.data.map((summary) => summary.nativeId)).toStrictEqual(['kept']);
  await expect(
    mergeSources({
      sources: [{ ...failing, read: () => Promise.reject(new Error('Unexpected failure')) }],
      limit: 4,
      last: null,
      signal: new AbortController().signal,
      isListed: () => true,
    }),
  ).rejects.toThrow('Unexpected failure');
});

test('a page whose signal ends leaves out the sources still reading', async () => {
  const controller = new AbortController();
  const listed = source('codex', false, [session('codex', 'listed', 100)], 4);
  const held: IMergeSource = {
    lane: 'claude',
    isOrdered: true,
    state: FIRST_READ,
    read: () => new Promise(() => undefined),
  };
  const merging = mergeSources({
    sources: [held, listed],
    limit: 4,
    last: null,
    signal: controller.signal,
    isListed: () => true,
  });
  await expect.poll(() => listed.reads.length).toBe(1);
  controller.abort();
  const page = await merging;
  expect(page).toMatchObject({ unavailable: [0], hasMore: false });
  expect(page.data.map((summary) => summary.nativeId)).toStrictEqual(['listed']);
});
