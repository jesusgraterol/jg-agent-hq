import { Exception } from 'error-message-utils';
import { z } from 'zod';

import type { IUsageSnapshot } from '../../contracts/index.js';

import { createCodexRpc } from './rpc.js';
import {
  NativeBucketSchema,
  NativeItemPageSchema,
  NativeThreadPageSchema,
  NativeThreadSchema,
  NativeTurnPageSchema,
  NativeUsageSchema,
  type ICodexProvider,
} from './types.js';
import { toHistoryItem, toThreadSummary, toTurnSummary, toUsageSnapshot } from './transformers.js';
import { parseNative } from './validations.js';

/**
 * Uses native read APIs only, without loading/resuming external threads or starting inference.
 * @returns The owned adapter. Its caller must close it on shutdown.
 * @throws
 * - -1: The Codex integration failed
 * - -1: The HQ transport failed
 */
export const createCodexProvider = async (): Promise<ICodexProvider> => {
  let latest: IUsageSnapshot = {
    provider: 'codex',
    state: 'unavailable',
    source: 'native',
    observedAt: null,
    ordinaryUsageAllowed: null,
    windows: [],
  };
  let rpc: Awaited<ReturnType<typeof createCodexRpc>> | undefined;
  let refresh: Promise<IUsageSnapshot> | undefined;
  let accountGeneration = 0;
  const readUsage = (): Promise<IUsageSnapshot> => {
    if (refresh) return refresh;
    const connection = rpc;
    if (!connection) return Promise.resolve(latest);
    const generation = accountGeneration;
    return (refresh = (async () => {
      try {
        const observation = toUsageSnapshot(
          parseNative(NativeUsageSchema, await connection.request('account/rateLimits/read', {})),
          Date.now(),
        );
        if (generation === accountGeneration) latest = observation;
      } catch {
        if (generation === accountGeneration)
          latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
      } finally {
        refresh = undefined;
      }
      if (
        (latest.observedAt !== null && Date.now() - latest.observedAt > 60_000) ||
        latest.windows.some((window) => window.resetsAt !== null && window.resetsAt <= Date.now())
      )
        latest = { ...latest, state: 'stale' };
      return latest;
    })());
  };
  rpc = await createCodexRpc((method, params) => {
    if (method !== 'account/rateLimits/updated' && method !== 'account/updated') return;
    if (method === 'account/updated') {
      accountGeneration += 1;
      latest = {
        provider: 'codex',
        state: 'unavailable',
        source: 'native',
        observedAt: null,
        ordinaryUsageAllowed: null,
        windows: [],
      };
    }
    if (
      method === 'account/rateLimits/updated' &&
      !z.object({ rateLimits: NativeBucketSchema }).safeParse(params).success
    ) {
      latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
      return;
    }
    // sparse updates invalidate the account observation; one native refresh reconciles all buckets
    latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
    void readUsage();
  });
  const connection = rpc;
  return {
    userAgent: connection.userAgent,
    get isAvailable() {
      return connection.isAvailable;
    },
    async listThreads(workspaceRoot, limit, cursor, search) {
      const page = parseNative(
        NativeThreadPageSchema,
        await connection.request('thread/list', {
          cwd: workspaceRoot,
          limit,
          cursor,
          searchTerm: search,
          sortKey: 'created_at',
          sortDirection: 'desc',
          useStateDbOnly: true,
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return { data: page.data.map(toThreadSummary), nextCursor: page.nextCursor };
    },
    async readThread(nativeId) {
      const result = parseNative(
        z.object({ thread: NativeThreadSchema }),
        await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
      );
      return toThreadSummary(result.thread);
    },
    async listTurns(nativeId, limit, cursor) {
      const page = parseNative(
        NativeTurnPageSchema,
        await connection.request('thread/turns/list', {
          threadId: nativeId,
          limit,
          cursor,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return { data: page.data.map(toTurnSummary), nextCursor: page.nextCursor };
    },
    async listItems(nativeId, limit, cursor, turnId) {
      const page = parseNative(
        NativeItemPageSchema,
        await connection.request('thread/items/list', {
          threadId: nativeId,
          turnId,
          limit,
          cursor,
          sortDirection: 'asc',
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return { data: page.data.map(toHistoryItem), nextCursor: page.nextCursor };
    },
    readUsage,
    close: connection.close,
  };
};
