import { Exception, isException } from 'jg-exception';
import { scheduler } from 'node:timers/promises';
import { z } from 'zod';

import type {
  IHqResponse,
  IUsageSnapshot,
  IProviderModelsRequest,
  IProviderModelPage,
  IConfigurationRequest,
} from '../../contracts/index.js';
import type { IStore } from '../../store/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';

import { createClaudeRpc } from './rpc.js';
import { ClaudeUsageSchema } from './types.js';
import { toClaudeUsageSnapshot } from './transformers.js';
import { readClaudeModels } from './models/index.js';
import { toClaudeConfiguration } from './configuration/index.js';
import { toClaudeAccount } from './accounts/index.js';

/**
 * Lazily connects read-only Claude capabilities; Codex needs no Claude installation.
 * @returns The read adapter with independent usage and transcript availability.
 */
export const createClaudeProvider = (store: IStore) => {
  let connection: Awaited<ReturnType<typeof createClaudeRpc>> | undefined;
  let opening: Promise<Awaited<ReturnType<typeof createClaudeRpc>>> | undefined;
  const metadataReads = new Set<Promise<Awaited<ReturnType<typeof createClaudeRpc>>>>();
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
    credits: null,
    resetCredits: null,
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
        new Exception('The Claude integration failed', {
          code: 'JG_AGENT_HQ_CLAUDE_FAILED',
          data: { kind: 'agent-unavailable' },
        }),
      );
    return (opening ??= connect());
  };
  /** Runs one bounded metadata read and confirms native shutdown before releasing its slot. */
  const withReadConnection = async <T>(
    workspaceRoot: string | undefined,
    signal: AbortSignal | undefined,
    read: (native: Awaited<ReturnType<typeof createClaudeRpc>>) => Promise<T>,
  ): Promise<T> => {
    if (isClosing || metadataReads.size >= 4)
      throw new Exception('The Claude integration failed', {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: { kind: 'agent-unavailable' },
      });
    const starting = createClaudeRpc(() => {}, undefined, workspaceRoot, signal);
    metadataReads.add(starting);
    let native: Awaited<ReturnType<typeof createClaudeRpc>> | undefined;
    let hasUnconfirmedStartup = false;
    try {
      native = await starting;
      if (isClosing)
        throw new Exception('The Claude integration failed', {
          code: 'JG_AGENT_HQ_CLAUDE_FAILED',
          data: { kind: 'agent-unavailable' },
        });
      return await read(native);
    } catch (cause) {
      hasUnconfirmedStartup =
        !native &&
        isException(cause) &&
        z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success;
      throw cause;
    } finally {
      if (native) await native.close();
      if (!hasUnconfirmedStartup) metadataReads.delete(starting);
    }
  };
  return {
    /**
     * Drops account-derived observations and the read connection after native sign-out.
     * @returns Confirmation that subsequent observations use a fresh native connection.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async invalidateAuthentication(): Promise<void> {
      generation += 1;
      latest = unavailable();
      if (opening) {
        const native = await opening;
        await native.close();
      }
      connection = undefined;
      opening = undefined;
    },
    /**
     * Verifies native initialization without requesting usage or starting inference.
     * @returns Confirmation that the read connection is ready.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async ensureReady(): Promise<void> {
      await open();
    },
    /**
     * Reads current native model choices without a user prompt.
     * @returns A bounded page whose continuation is tied to the observed inventory.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     */
    async readModels(command: IProviderModelsRequest): Promise<IProviderModelPage> {
      const native = await open();
      return readClaudeModels(await native.requestControl({ subtype: 'list_models' }), command);
    },
    /**
     * Opens a workspace-scoped read lane without a user prompt or model turn.
     * @returns Known effective native fields; the lane is closed before returning.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async readConfiguration(command: IConfigurationRequest, signal?: AbortSignal) {
      return withReadConnection(command.workspaceRoot, signal, async (native) =>
        toClaudeConfiguration(
          await native.requestControl({ subtype: 'get_settings' }),
          native.initialization.agents,
          native.initialization.current_permission_mode,
          undefined,
          {},
          command,
        ),
      );
    },
    /**
     * Reads fresh native account metadata in a disposable read lane.
     * @returns Safe account metadata after confirmed read-lane cleanup.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async readAccount(signal?: AbortSignal) {
      return withReadConnection(undefined, signal, async (native) =>
        toClaudeAccount(native.initialization.account, native.initializedAt),
      );
    },

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
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     */
    async readHistory(command: IHistoryRequest): Promise<IHqResponse> {
      const deadline = Date.now() + 30_000;
      await open();
      while (!isClosing && Date.now() < deadline) {
        const result = await store.readClaudeHistory(command);
        if (result.kind !== 'indexing') return result;
        await scheduler.yield();
      }
      throw new Exception('The Claude history is unavailable', {
        code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
        data: {
          kind: 'agent-unavailable',
        },
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
            throw new Exception('The Claude integration failed', {
              code: 'JG_AGENT_HQ_CLAUDE_FAILED',
              data: { kind: 'agent-unavailable' },
              cause: parsed.error,
            });
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
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async close(): Promise<void> {
      isClosing = true;
      const results = await Promise.allSettled(
        [...(opening ? [opening] : []), ...metadataReads].map(async (starting) => {
          let native: Awaited<ReturnType<typeof createClaudeRpc>>;
          try {
            native = await starting;
          } catch (cause) {
            if (
              isException(cause) &&
              z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success
            )
              throw cause;
            return;
          }
          await native.close();
        }),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
};
