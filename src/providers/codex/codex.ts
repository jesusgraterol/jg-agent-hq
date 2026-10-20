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
  NativeTurnSchema,
  type ICodexEvents,
  type ICodexProvider,
} from './types.js';
import { toHistoryItem, toThreadSummary, toTurnSummary, toUsageSnapshot } from './transformers.js';
import { parseNative } from './validations.js';

/**
 * Connects native history, account observations and explicitly admitted runtime controls.
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
  let events: ICodexEvents | undefined;
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
  rpc = await createCodexRpc({
    request: (id, method, params) => {
      if (events) events.request(id, method, params);
      else void rpc?.reject(id).catch(() => undefined);
    },
    lateResponse: (id, result, error) => events?.lateResponse(id, result, error),
    unavailable: () => events?.unavailable(),
    notify: (method, params) => {
      events?.notify(method, params);
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
    },
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
      if (result.thread.id !== nativeId)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
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
    setEvents: (handlers) => {
      events = handlers;
    },
    async startThread(requestId, workspaceRoot) {
      return parseNative(
        z.object({ thread: NativeThreadSchema }),
        await connection.request('thread/start', { cwd: workspaceRoot }, requestId),
      ).thread;
    },
    async resumeThread(requestId, nativeId) {
      const result = parseNative(
        z.object({ thread: NativeThreadSchema }),
        await connection.request(
          'thread/resume',
          { threadId: nativeId, excludeTurns: true },
          requestId,
        ),
      );
      if (result.thread.id !== nativeId)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return result.thread;
    },
    async nameThread(requestId, nativeId, name) {
      parseNative(
        z.object({}),
        await connection.request('thread/name/set', { threadId: nativeId, name }, requestId),
      );
    },
    async startTurn(requestId, nativeId, text) {
      return parseNative(
        z.object({ turn: NativeTurnSchema }),
        await connection.request(
          'turn/start',
          { threadId: nativeId, input: [{ type: 'text', text }] },
          requestId,
        ),
      ).turn;
    },
    async steer(requestId, nativeId, expectedTurnId, text) {
      const result = parseNative(
        z.object({ turnId: z.string().min(1).max(4096) }),
        await connection.request(
          'turn/steer',
          { threadId: nativeId, expectedTurnId, input: [{ type: 'text', text }] },
          requestId,
        ),
      );
      if (result.turnId !== expectedTurnId)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return result.turnId;
    },
    async interrupt(requestId, nativeId, nativeTurnId) {
      parseNative(
        z.object({}),
        await connection.request(
          'turn/interrupt',
          { threadId: nativeId, turnId: nativeTurnId },
          requestId,
        ),
      );
    },
    async cleanTerminals(requestId, nativeId) {
      parseNative(
        z.object({}),
        await connection.request(
          'thread/backgroundTerminals/clean',
          { threadId: nativeId },
          requestId,
        ),
      );
    },
    async verifyTerminalsClosed(nativeId) {
      const page = parseNative(
        z.object({
          data: z.array(z.unknown()).max(1),
          nextCursor: z.string().nullable().optional(),
        }),
        await connection.request('thread/backgroundTerminals/list', {
          threadId: nativeId,
          limit: 1,
        }),
      );
      if (page.data.length || page.nextCursor)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
    },
    async unsubscribe(requestId, nativeId) {
      const result = parseNative(
        z.object({ status: z.string() }),
        await connection.request('thread/unsubscribe', { threadId: nativeId }, requestId),
      );
      if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result.status))
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
    },
    reply: connection.reply,
    reject: connection.reject,
    close: connection.close,
  };
};
