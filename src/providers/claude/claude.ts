import { Exception, isException } from 'jg-exception';
import { delay } from 'jg-utilities';
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

// the session-less read process closes after this long without a read, and reopens on the next one
const METADATA_IDLE_SECONDS = 300;
// a usage result read this recently answers the next read without asking Claude again
const USAGE_KEPT_MS = 60_000;

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
  let reads = 0;
  let idleClose: AbortController | undefined;
  // a closing idle read process, whose failure surfaces at shutdown
  let retiring: Promise<void> | undefined;
  let version: string | null = null;
  // the first read process that started and initialized confirms the CLI for transcript reads
  let isVerified = false;
  let refresh: Promise<IUsageSnapshot> | undefined;
  // when the kept usage result was read, and a count of the changes that outdate it
  let usageReadAt: number | null = null;
  let usageChanges = 0;
  /** Ends the kept usage result early, after an account, limit or connection change. */
  const expireUsage = (): void => {
    usageChanges += 1;
    usageReadAt = null;
  };
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
  /** Marks the latest usage stale once it is a minute old or one of its windows has reset. */
  const currentUsage = (): IUsageSnapshot => {
    if (
      (latest.observedAt !== null && Date.now() - latest.observedAt > 60_000) ||
      latest.windows.some((window) => window.resetsAt !== null && window.resetsAt <= Date.now())
    )
      latest = { ...latest, state: 'stale' };
    return latest;
  };
  const connect = async () => {
    connection = await createClaudeRpc((reason) => {
      expireUsage();
      if (reason === 'account') {
        generation += 1;
        latest = unavailable();
      } else latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
    });
    version = connection.version;
    isVerified = true;
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
  /** Closes the read process once it has gone unused, so the next read opens a fresh one. */
  const retire = (): void => {
    idleClose = undefined;
    const native = connection;
    if (!native || reads > 0 || isClosing) return;
    connection = undefined;
    opening = undefined;
    retiring = native.close();
    retiring.catch(() => undefined);
  };
  /**
   * Runs one read on the session-less process, opening it when it is closed.
   * @returns The read's result; the process closes after the idle period without another read.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const withMetadata = async <T>(
    read: (native: Awaited<ReturnType<typeof createClaudeRpc>>) => Promise<T>,
  ): Promise<T> => {
    idleClose?.abort();
    idleClose = undefined;
    reads += 1;
    try {
      return await read(await open());
    } finally {
      reads -= 1;
      if (reads === 0 && !isClosing) {
        const controller = new AbortController();
        idleClose = controller;
        void delay(METADATA_IDLE_SECONDS, { signal: controller.signal }).then(
          retire,
          () => undefined,
        );
      }
    }
  };
  /**
   * Confirms once that the Claude CLI starts and initializes; later calls keep that result
   * instead of opening the read process again.
   * @returns Confirmation that the CLI was verified.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const verify = async (): Promise<void> => {
    if (!isVerified) await withMetadata(async () => undefined);
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
      idleClose?.abort();
      idleClose = undefined;
      generation += 1;
      expireUsage();
      latest = unavailable();
      if (opening) {
        const native = await opening;
        await native.close();
      }
      connection = undefined;
      opening = undefined;
    },
    /**
     * Verifies native initialization without requesting usage or starting inference, keeping the
     * runtime's first successful check.
     * @returns Confirmation that the CLI was verified.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async ensureReady(): Promise<void> {
      await verify();
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
      return withMetadata(async (native) =>
        readClaudeModels(await native.requestControl({ subtype: 'list_models' }), command),
      );
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

    // the last observed version stays known while the read process is closed
    get version() {
      return connection?.version ?? version;
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
     * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     */
    async readHistory(command: IHistoryRequest): Promise<IHqResponse> {
      const deadline = Date.now() + 30_000;
      await verify();
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
     * Reads account windows, retaining a failed observation as stale rather than zero. A result
     * read less than 60 seconds ago answers without asking Claude again, unless an account, limit
     * or connection change ended it.
     * @returns Actual native windows or an explicit freshness/unavailable state.
     */
    readUsage(): Promise<IUsageSnapshot> {
      if (refresh) return refresh;
      if (usageReadAt !== null && Date.now() - usageReadAt < USAGE_KEPT_MS)
        return Promise.resolve(currentUsage());
      const changes = usageChanges;
      return (refresh = (async () => {
        try {
          await withMetadata(async (native) => {
            const epoch = generation;
            const parsed = ClaudeUsageSchema.safeParse(await native.requestUsage());
            if (!parsed.success)
              throw new Exception('The Claude integration failed', {
                code: 'JG_AGENT_HQ_CLAUDE_FAILED',
                data: { kind: 'agent-unavailable' },
                cause: parsed.error,
              });
            if (epoch === generation) latest = toClaudeUsageSnapshot(parsed.data, Date.now());
          });
        } catch {
          latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
        } finally {
          refresh = undefined;
          // a change during the read outdates its result, so the next read asks Claude again
          if (changes === usageChanges) usageReadAt = Date.now();
        }
        return currentUsage();
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
      idleClose?.abort();
      idleClose = undefined;
      const results = await Promise.allSettled([
        ...(retiring ? [retiring] : []),
        ...[...(opening ? [opening] : []), ...metadataReads].map(async (starting) => {
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
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
};
