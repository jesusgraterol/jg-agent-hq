import { Exception } from 'error-message-utils';
import { scheduler } from 'node:timers/promises';
import { z } from 'zod';

import type { IHqResponse, IUsageSnapshot } from '../../contracts/index.js';
import type { IStore } from '../../store/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';

import { createClaudeRpc } from './rpc.js';
import { ClaudeHistoryVersionSchema, ClaudeUsageSchema } from './types.js';
import { toClaudeUsageSnapshot } from './transformers.js';

/**
 * Lazily connects read-only Claude capabilities; Codex needs no Claude installation.
 * @returns The read adapter with explicit unavailable usage and version-gated history.
 */
export const createClaudeProvider = (store: IStore) => {
  let connection: Awaited<ReturnType<typeof createClaudeRpc>> | undefined;
  let opening: Promise<Awaited<ReturnType<typeof createClaudeRpc>>> | undefined;
  let isClosing = false;
  let generation = 0;
  let refresh: Promise<IUsageSnapshot> | undefined;
  const unavailable = (): IUsageSnapshot => ({
    provider: 'claude',
    state: 'unavailable',
    source: 'native',
    observedAt: null,
    ordinaryUsageAllowed: null,
    windows: [],
  });
  let latest = unavailable();
  const connect = async () => {
    connection = await createClaudeRpc((reason) => {
      if (reason === 'account') {
        generation += 1;
        latest = unavailable();
      } else latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
    });
    return connection;
  };
  const open = () => {
    if (isClosing)
      return Promise.reject(
        new Exception('The Claude integration failed', undefined, { kind: 'agent-unavailable' }),
      );
    return (opening ??= connect());
  };
  return {
    get version() {
      return connection?.version ?? null;
    },
    get isAvailable() {
      return connection?.isAvailable ?? false;
    },
    get state(): 'idle' | 'ready' | 'unavailable' {
      return connection?.isAvailable ? 'ready' : opening === undefined ? 'idle' : 'unavailable';
    },
    /**
     * Reads only a verified local transcript capability without resuming a session.
     * @returns One bounded native-file read through the owned worker.
     * @throws
     * - -1: The Claude integration failed
     * - -1: The Claude history is unavailable
     * - -1: The HQ store failed
     * - -1: The HQ cursor does not match this request
     */
    async readHistory(command: IHistoryRequest): Promise<IHqResponse> {
      const deadline = Date.now() + 30_000;
      const native = await open();
      if (!ClaudeHistoryVersionSchema.safeParse(native.version).success)
        throw new Exception('The Claude history is unavailable', undefined, {
          kind: 'agent-unavailable',
        });
      while (!isClosing && Date.now() < deadline) {
        const result = await store.readClaudeHistory(command);
        if (result.kind !== 'indexing') return result;
        await scheduler.yield();
      }
      throw new Exception('The Claude history is unavailable', undefined, {
        kind: 'agent-unavailable',
      });
    },
    /**
     * Reads account windows, retaining a failed observation as stale rather than zero.
     * @returns Actual native windows or an explicit freshness/unavailable state.
     */
    readUsage(): Promise<IUsageSnapshot> {
      if (refresh) return refresh;
      return (refresh = (async () => {
        try {
          const native = await open();
          const epoch = generation;
          const parsed = ClaudeUsageSchema.safeParse(await native.requestUsage());
          if (!parsed.success)
            throw new Exception(
              'The Claude integration failed',
              undefined,
              { kind: 'agent-unavailable' },
              { cause: parsed.error },
            );
          if (epoch !== generation) return latest;
          latest = toClaudeUsageSnapshot(parsed.data, Date.now());
        } catch {
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
    },
    /**
     * Closes even a connection still starting when runtime shutdown began.
     * @returns Confirmed native shutdown, or no work when the adapter was unused.
     * @throws
     * - -1: The Claude integration failed
     * - -1: The HQ transport failed
     */
    async close(): Promise<void> {
      isClosing = true;
      if (opening) {
        try {
          await opening;
        } catch (cause) {
          if (
            cause instanceof Exception &&
            z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success
          )
            throw cause;
          return;
        }
      }
      await connection?.close();
    },
  };
};
