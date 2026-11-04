import { compareCodePoints, createDeadline } from 'jg-utilities';

import { MAX_PAGE_SIZE, type IHqRequest, type IThreadsPage } from '../../contracts/index.js';
import type { createProviderRegistry } from '../../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import type { IStore } from '../../store/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import type { IClaudeSessions } from '../types.js';
import { joinRecords, toManagedSummaries, withListing } from '../summaries.js';

import { DISCOVERY_TIMEOUT_SECONDS, FIRST_READ } from './constants.js';
import { ListKeySchema, type IMergeSource, type IMergeResult } from './types.js';
import { decodeDiscoveryCursor, encodeDiscoveryCursor, toListKey } from './utilities.js';
import { mergeSources } from './merge.js';

/**
 * Lists sessions across folders and providers, last activity first, then provider and native ID:
 * each folder's native sessions with the managed sessions HQ created that no turn has started.
 * A managed session's activity time is its record's last update until its first turn writes
 * native history. Each native list resumes from the continuation the cursor kept for it, and HQ's
 * records seek past the cursor's last session. A provider that can't be read, or that the page's
 * 25 seconds don't reach, is left out of the page and named in `unavailable`; its folder's
 * sessions stay out of the pages that continue it.
 * @param command The folders, providers, name search, continued filter, page size and cursor.
 * @param registry The providers.
 * @param projection The store.
 * @param allowedRoots The workspaces HQ may read.
 * @param claude What the latest `claude agents --json` run reported.
 * @returns A promise that resolves to the page.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readThreads = async (
  command: Extract<IHqRequest, { kind: 'threads' }>,
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IThreadsPage> => {
  const roots = [...command.workspaceRoots].sort(compareCodePoints);
  const providers = [...command.providers].sort(compareCodePoints);
  // a cursor continues the same filters in any order
  const filters = {
    workspaceRoots: roots,
    providers,
    search: command.search ?? null,
    excludeContinued: command.excludeContinued,
  };
  const resolved = await Promise.all(
    roots.map((root) => resolveWorkspaceTarget(root, allowedRoots)),
  );
  // two paths to one folder would list its sessions twice
  if (new Set(resolved).size !== resolved.length)
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  const native = resolved.flatMap((workspaceRoot) =>
    providers.map((provider) => ({ workspaceRoot, provider })),
  );
  const position = decodeDiscoveryCursor(command.cursor, filters, native.length);
  const sources: IMergeSource[] = native.map(({ workspaceRoot, provider }, index) => ({
    lane: provider,
    // Claude's index lists in the list's order, while Codex sorts by last activity alone
    isOrdered: provider === 'claude',
    state: position ? position.sources[index]! : FIRST_READ,
    // each adapter checks that the sessions it lists ran in the folder
    read: async (cursor) =>
      (await registry.get(provider)).listThreads(workspaceRoot, {
        search: command.search,
        // one session past a page shows that Codex's last listed one has no tie it hasn't read
        limit: provider === 'claude' ? command.limit : Math.min(command.limit + 1, MAX_PAGE_SIZE),
        cursor,
      }),
  }));
  // HQ's own records seek past the last session listed, so no state of theirs is kept
  const unstarted: IMergeSource = {
    lane: 'hq',
    isOrdered: true,
    state: FIRST_READ,
    async read(cursor) {
      const listed = await projection.call('reads', 'listUnstartedThreads', {
        workspaceRoots: resolved,
        providers,
        search: command.search ?? null,
        after: cursor === null ? (position?.last ?? null) : ListKeySchema.parse(JSON.parse(cursor)),
        limit: command.limit,
      });
      const data = await toManagedSummaries(projection, listed.data);
      const last = data.at(-1);
      return {
        data,
        nextCursor: listed.hasMore && last ? JSON.stringify(toListKey(last)) : null,
      };
    },
  };
  const deadline = createDeadline({ timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS });
  let merged: IMergeResult;
  try {
    merged = await mergeSources({
      sources: [...sources, unstarted],
      limit: command.limit,
      last: position?.last ?? null,
      signal: deadline.signal,
      isListed: (summary) => !command.excludeContinued || summary.continuedIn === null,
    });
  } finally {
    deadline.dispose();
  }
  // native summaries take what HQ records of them; HQ's own records already carry it
  for (const provider of providers)
    await joinRecords(
      projection,
      claude,
      provider,
      merged.data.filter((thread) => thread.provider === provider && thread.managedId === null),
    );
  return {
    data: merged.data.map((thread) => withListing(thread, claude)),
    nextCursor:
      merged.hasMore && merged.last
        ? encodeDiscoveryCursor(
            { last: merged.last, sources: merged.states.slice(0, native.length) },
            filters,
          )
        : null,
    unavailable: merged.unavailable.flatMap((index) => native[index] ?? []),
  };
};
