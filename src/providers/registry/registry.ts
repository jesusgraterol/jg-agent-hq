import { isException } from 'jg-exception';
import { abortable, createDeadline } from 'jg-utilities';
import { z } from 'zod';

import type {
  IManagedThread,
  IProviderCapabilities,
  IProviderCapabilitySet,
  IProviderId,
  IProviderStatus,
  IUsageSnapshot,
} from '../../contracts/index.js';
import type {
  IAgentProvider,
  IAgentProviderEvents,
  IAgentProviderFactory,
  INativePrompt,
  IProviderCall,
  IStoppedControl,
  IControlSource,
  IControlSnapshot,
  IControlObservation,
} from '../index.js';
import { isCleanupUnconfirmed } from '../../errors/index.js';

import type { IBoundAgentProvider, IProviderRegistryEvents } from './types.js';
import { capabilityUnavailable, normalizeProviderError } from './utilities.js';

type IProviderEntry = {
  factory: IAgentProviderFactory;
  opening?: Promise<IAgentProvider>;
  ready?: Promise<IBoundAgentProvider>;
  adapter?: IAgentProvider;
  closing?: Promise<void>;
  failure?: unknown;
  stopping: Map<string, Promise<IStoppedControl | void>>;
};

/** Returns an explicit observation when no usable capability descriptor could be obtained. */
const unavailableCapabilities = (): IProviderCapabilitySet => {
  const unavailable = {
    state: 'unavailable' as const,
    changeMode: null,
    reason: { code: 'provider-unavailable', message: 'Provider capabilities are unavailable.' },
  };
  return {
    operations: {
      create: unavailable,
      adopt: unavailable,
      resume: unavailable,
      rename: unavailable,
      close: unavailable,
      interrupt: unavailable,
      recover: unavailable,
      steer: unavailable,
      history: unavailable,
      usage: unavailable,
      skills: unavailable,
      models: unavailable,
      configuration: unavailable,
    },
    inputSchema: null,
    configurationSchema: null,
  };
};

/**
 * Bounds one provider operation without retrying an uncertain native side effect.
 * @returns The operation result, or rejection when its deadline/lifetime ends.
 */
const bounded = async <T>(
  operation: (call: IProviderCall) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const deadline = createDeadline({ timeoutSeconds: 30, ...(signal ? { signal } : {}) });
  try {
    deadline.throwIfStopped();
    return await abortable(operation({ signal: deadline.signal }), { signal: deadline.signal });
  } finally {
    deadline.dispose();
  }
};

/**
 * Holds the built-in factories and starts only the provider explicitly selected by an operation.
 * @returns Runtime-owned routing, observations and confirmed adapter cleanup.
 */
export const createProviderRegistry = (
  factories: IAgentProviderFactory[],
  allowedRoots: string[],
  runtimeEpoch: string,
) => {
  const entries = new Map<IProviderId, IProviderEntry>(
    factories.map((factory) => [factory.id, { factory, stopping: new Map() }]),
  );
  const lifetime = new AbortController();
  let handlers: IProviderRegistryEvents | undefined;
  let closing: Promise<void> | undefined;
  let isClosing = false;

  /**
   * Confirms one adapter's cleanup once, retaining its failure for runtime shutdown.
   * @returns Confirmed cleanup of every resource owned by the adapter.
   * @throws
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const closeEntry = (entry: IProviderEntry): Promise<void> =>
    (entry.closing ??= (async () => {
      try {
        if (entry.adapter) await bounded(() => entry.adapter!.close());
      } catch (cause) {
        throw normalizeProviderError(cause);
      }
    })());

  /** Quarantines a failed provider without throwing into a native event emitter. */
  const quarantine = (entry: IProviderEntry, cause: unknown): void => {
    entry.failure ??= normalizeProviderError(cause);
    handlers?.unavailable(entry.factory.id);
    if (entry.adapter) void closeEntry(entry).catch(() => undefined);
  };
  /** Verifies controller attribution against the adapter's live handle in this registry epoch. */
  const matchesSource = (entry: IProviderEntry, source: IControlSource): boolean => {
    const current = entry.adapter?.getControlSource?.(source.nativeId);
    return current?.scope === source.scope && current.workspaceRoot === source.workspaceRoot;
  };
  /** Contains an attributable Claude interpretation failure without closing a provider. */
  const quarantineOwned = (
    entry: IProviderEntry,
    source: IControlSource | undefined,
    cause?: unknown,
  ): boolean =>
    entry.factory.id === 'claude' &&
    source !== undefined &&
    matchesSource(entry, source) &&
    entry.adapter?.quarantineControl?.(source, cause) === true;

  /** Binds provider identity to the adapter's evidence and bounds its native replies. */
  const eventsFor = (entry: IProviderEntry): IAgentProviderEvents => {
    const provider = entry.factory.id;
    const deliver = (
      operation: () => void,
      source?: IControlSource,
      isLifecycle = false,
      nativeId?: string,
    ): void => {
      if (entry.failure || isClosing) return;
      if (
        source &&
        (!matchesSource(entry, source) ||
          (!isLifecycle && entry.adapter?.isControlQuarantined?.(source)))
      )
        return;
      if (source && nativeId !== undefined && source.nativeId !== nativeId) {
        quarantineOwned(entry, source);
        return;
      }
      try {
        operation();
      } catch (cause) {
        if (
          !(isException(cause) && cause.code === 'JG_AGENT_HQ_STORE_FAILED') &&
          quarantineOwned(entry, source, cause)
        )
          return;
        quarantine(entry, cause);
      }
    };
    return {
      observe: (observation, source) =>
        deliver(
          () =>
            handlers?.observe(
              provider,
              {
                ...observation,
                provider,
                ...(source &&
                observation.kind === 'native-unavailable' &&
                observation.nativeThreadId === undefined
                  ? { nativeThreadId: source.nativeId }
                  : {}),
              },
              source,
            ),
          source,
          false,
          observation.nativeThreadId,
        ),
      item: (nativeId, item, isComplete, replacedIds, source) =>
        deliver(
          () => handlers?.item(provider, nativeId, item, isComplete, replacedIds, source),
          source,
          false,
          nativeId,
        ),
      gap: (nativeId, source) =>
        deliver(() => handlers?.gap(provider, nativeId, source), source, false, nativeId),
      background: (nativeId, count, source) =>
        deliver(
          () => handlers?.background(provider, nativeId, count, source),
          source,
          true,
          nativeId,
        ),
      session: (nativeId, state, thread, source) =>
        deliver(
          () => handlers?.session(provider, nativeId, state, thread, source),
          source,
          false,
          nativeId,
        ),
      delta: (nativeId, turnId, itemId, text, source) =>
        deliver(
          () => handlers?.delta(provider, nativeId, turnId, itemId, text, source),
          source,
          false,
          nativeId,
        ),
      prompt: (prompt, source) =>
        deliver(
          () => {
            const bound: INativePrompt = {
              ...prompt,
              validate(response) {
                try {
                  return prompt.validate(response);
                } catch (cause) {
                  throw normalizeProviderError(cause);
                }
              },
              async reply(response) {
                try {
                  await bounded(() => prompt.reply(response), lifetime.signal);
                } catch (cause) {
                  throw normalizeProviderError(cause);
                }
              },
              async reject() {
                try {
                  await bounded(() => prompt.reject(), lifetime.signal);
                } catch (cause) {
                  throw normalizeProviderError(cause);
                }
              },
            };
            if (handlers) handlers.prompt(provider, bound, source);
            else
              void bound.reject().catch((cause) => {
                if (!quarantineOwned(entry, source, cause)) quarantine(entry, cause);
              });
          },
          source,
          false,
          prompt.nativeThreadId,
        ),
      unpresentable: (nativeId, reject, source) =>
        deliver(
          () => {
            const bound = async (): Promise<void> => {
              try {
                await bounded(() => reject(), lifetime.signal);
              } catch (cause) {
                throw normalizeProviderError(cause);
              }
            };
            if (handlers) handlers.unpresentable(provider, nativeId, bound, source);
            else
              void bound().catch((cause) => {
                if (!quarantineOwned(entry, source, cause)) quarantine(entry, cause);
              });
          },
          source,
          false,
          nativeId,
        ),
      resync: (nativeId, lost, source) =>
        deliver(
          () => handlers?.resync(provider, nativeId ?? source?.nativeId, lost, source),
          source,
          false,
          nativeId,
        ),
      // a created or resumed session's lineage comes from the native thread the adapter read
      outcome: (outcome, thread, source) =>
        deliver(
          () =>
            handlers?.outcome(
              provider,
              outcome.kind === 'created' || outcome.kind === 'resumed'
                ? { ...outcome, nativeLineage: thread?.nativeLineage ?? null }
                : outcome,
              thread,
              source,
            ),
          source,
          false,
          thread?.nativeId,
        ),
      unavailable: (nativeId, controlScope, source) =>
        deliver(
          () => handlers?.unavailable(provider, nativeId ?? source?.nativeId, controlScope, source),
          source,
          true,
          nativeId,
        ),
      quarantined: (source) => deliver(() => handlers?.quarantined(provider, source), source, true),
      quiescent: (source) => deliver(() => handlers?.quiescent(provider, source), source, true),
    };
  };

  /**
   * Initializes one adapter and preserves the failed state rather than replaying construction.
   * @returns The selected runtime-bound adapter.
   * @throws
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   */
  const get = async (provider: IProviderId): Promise<IBoundAgentProvider> => {
    const entry = entries.get(provider);
    if (!entry || isClosing) capabilityUnavailable();
    if (entry.failure) throw entry.failure;
    return (entry.ready ??= (async () => {
      try {
        const adapter = await bounded(async (call) => {
          entry.opening = Promise.resolve(
            entry.factory.create({
              allowedRoots: [...allowedRoots],
              runtimeEpoch,
              signal: call.signal,
              events: eventsFor(entry),
            }),
          );
          const opened = await entry.opening;
          entry.adapter = opened;
          if (entry.failure || isClosing) await closeEntry(entry);
          return opened;
        }, lifetime.signal);
        if (entry.failure) throw entry.failure;
        const invoke = async <T>(operation: (call: IProviderCall) => Promise<T>): Promise<T> => {
          if (entry.failure || isClosing) capabilityUnavailable();
          try {
            const result = await bounded(operation, lifetime.signal);
            if (entry.failure) throw entry.failure;
            return result;
          } catch (cause) {
            throw normalizeProviderError(cause);
          }
        };
        // a control the adapter couldn't parse leaves its native state unknown, so it quarantines
        const invokeControl = async <T>(
          operation: (call: IProviderCall) => Promise<T>,
          nativeId?: string,
        ): Promise<T> =>
          invoke(async (call) => {
            const source = nativeId ? adapter.getControlSource?.(nativeId) : undefined;
            try {
              return await operation(call);
            } catch (cause) {
              if (
                cause instanceof z.ZodError ||
                (isException(cause) && cause.cause instanceof z.ZodError)
              ) {
                const current = nativeId ? adapter.getControlSource?.(nativeId) : undefined;
                if (source) quarantineOwned(entry, source, cause);
                else if (!current || !adapter.isControlQuarantined?.(current))
                  quarantine(entry, cause);
              }
              throw cause;
            }
          });
        return {
          get state() {
            return adapter.state;
          },
          get version() {
            return adapter.version;
          },
          get isAvailable() {
            return !entry.failure && adapter.isAvailable;
          },
          readCapabilities: (nativeId) =>
            invoke((call) => adapter.readCapabilities(nativeId, call)),
          listThreads: (workspaceRoot, page) =>
            invoke((call) => adapter.listThreads(workspaceRoot, page, call)),
          readHistory: (command) => invoke((call) => adapter.readHistory(command, call)),
          readModels: (command) => invoke((call) => adapter.readModels(command, call)),
          inspectThread: (nativeId, workspaceRoot) =>
            invokeControl((call) => adapter.inspectThread(nativeId, workspaceRoot, call), nativeId),
          readConfiguration: (command, nativeId) =>
            invoke((call) => adapter.readConfiguration(command, nativeId, call)),
          readUsage: () => invoke((call) => adapter.readUsage(call)),
          readSkills: (workspaceRoot, nativeId) =>
            invoke((call) => adapter.readSkills(workspaceRoot, nativeId, call)),
          formatSkill: (skill, argumentsText) => adapter.formatSkill(skill, argumentsText),
          startThread: (requestId, workspaceRoot, settings) =>
            invokeControl((call) => adapter.startThread(requestId, workspaceRoot, settings, call)),
          resumeThread: (requestId, nativeId, workspaceRoot, name, settings) =>
            invokeControl(
              (call) =>
                adapter.resumeThread(requestId, nativeId, workspaceRoot, name, settings, call),
              nativeId,
            ),
          ...(adapter.readReattachment && adapter.reattachThread
            ? {
                readReattachment: (nativeId: string, workspaceRoot: string) =>
                  invokeControl((call) => adapter.readReattachment!(nativeId, workspaceRoot, call)),
                reattachThread: (requestId: string, nativeId: string, workspaceRoot: string) =>
                  invokeControl((call) =>
                    adapter.reattachThread!(requestId, nativeId, workspaceRoot, call),
                  ),
              }
            : {}),
          nameThread: (requestId, nativeId, name) =>
            invokeControl((call) => adapter.nameThread(requestId, nativeId, name, call), nativeId),
          validateInput: (nativeId, input) =>
            invoke((call) => adapter.validateInput(nativeId, input, call)),
          startTurn: (requestId, nativeId, text, skill, settings, files) =>
            invokeControl(
              (call) => adapter.startTurn(requestId, nativeId, text, skill, settings, files, call),
              nativeId,
            ),
          steer: (requestId, nativeId, expectedTurnId, text, files) =>
            invokeControl(
              (call) => adapter.steer(requestId, nativeId, expectedTurnId, text, files, call),
              nativeId,
            ),
          interrupt: (requestId, nativeId, nativeTurnId) =>
            invokeControl(
              (call) => adapter.interrupt(requestId, nativeId, nativeTurnId, call),
              nativeId,
            ),
          cleanThread: (requestId, nativeId) =>
            invokeControl((call) => adapter.cleanThread(requestId, nativeId, call), nativeId),
          releaseThread: (requestId, nativeId) =>
            invokeControl((call) => adapter.releaseThread(requestId, nativeId, call), nativeId),
          deleteThread: (requestId, nativeId, workspaceRoot) =>
            invokeControl(
              (call) => adapter.deleteThread(requestId, nativeId, workspaceRoot, call),
              nativeId,
            ),
          prepareShutdown: (nativeId) => invoke((call) => adapter.prepareShutdown(nativeId, call)),
          stopControl: (nativeId) => invoke((call) => adapter.stopControl(nativeId, call)),
          close: () => closeEntry(entry),
        } satisfies IBoundAgentProvider;
      } catch (cause) {
        entry.failure ??= normalizeProviderError(cause);
        throw entry.failure;
      }
    })());
  };

  return {
    get,
    /** @returns Whether this exact source still belongs to this runtime's adapter. */
    isCurrentControl(provider: IProviderId, source: IControlSource): boolean {
      const entry = entries.get(provider);
      return !!entry && !entry.failure && !isClosing && matchesSource(entry, source);
    },
    /** @returns The private current controller identity without starting the adapter. */
    getControlSource(provider: IProviderId, nativeId: string): IControlSource | undefined {
      return entries.get(provider)?.adapter?.getControlSource?.(nativeId);
    },
    /** @returns Whether the exact owned controller remains quarantined in this runtime. */
    isControlQuarantined(provider: IProviderId, source: IControlSource): boolean {
      const entry = entries.get(provider);
      return (
        !!entry &&
        matchesSource(entry, source) &&
        entry.adapter?.isControlQuarantined?.(source) === true
      );
    },
    /** @returns Whether an attributable evidence failure was contained by its controller. */
    quarantineControl(provider: IProviderId, source: IControlSource, cause?: unknown): boolean {
      const entry = entries.get(provider);
      return !!entry && quarantineOwned(entry, source, cause);
    },
    /** @returns Current owned handles before a shared inventory, without opening an adapter. */
    snapshotControls(provider: IProviderId): IControlSnapshot[] {
      const entry = entries.get(provider);
      return entry && !entry.failure && !isClosing
        ? (entry.adapter?.snapshotControls?.() ?? [])
        : [];
    },
    /** Applies bounded inventory evidence only to the adapter already owned by this runtime. */
    observeControls(
      provider: IProviderId,
      snapshots: IControlSnapshot[],
      observations: IControlObservation[] | null,
    ): void {
      const entry = entries.get(provider);
      if (entry && !entry.failure && !isClosing)
        entry.adapter?.observeControls?.(snapshots, observations);
    },
    /** Quarantines one provider after a source-specific lifecycle gap or invalid control response. */
    quarantine(provider: IProviderId, cause: unknown): void {
      const entry = entries.get(provider);
      if (entry && !entry.failure) quarantine(entry, cause);
    },
    /** Installs runtime-owned callbacks without constructing any adapter. */
    setEvents(events: IProviderRegistryEvents): void {
      handlers = events;
    },
    /** @returns Connection observations without native startup or inference. */
    statuses(): IProviderStatus[] {
      return [...entries].map(([provider, entry]) => ({
        provider,
        state: entry.failure ? 'unavailable' : (entry.adapter?.state ?? 'idle'),
        version: entry.adapter?.version ?? null,
      }));
    },
    /** @returns An explicit scoped capability observation, independently of other providers. */
    async capabilities(
      provider: IProviderId,
      thread?: IManagedThread,
    ): Promise<IProviderCapabilities> {
      let result: IProviderCapabilitySet;
      try {
        const adapter = await get(provider);
        if (!adapter.isAvailable || (thread && !thread.nativeId)) capabilityUnavailable();
        result = await adapter.readCapabilities(thread?.nativeId ?? undefined);
      } catch {
        result = unavailableCapabilities();
      }
      return {
        ...result,
        provider,
        observedAt: Date.now(),
        scope: thread ? { kind: 'session', threadId: thread.id } : { kind: 'provider' },
      };
    },
    /** @returns Native quota data, or an explicit unavailable observation when it cannot be read. */
    async readUsage(provider: IProviderId): Promise<IUsageSnapshot> {
      try {
        return await (await get(provider)).readUsage();
      } catch {
        return {
          provider,
          state: 'unavailable',
          source: 'native',
          observedAt: null,
          ordinaryUsageAllowed: null,
          windows: [],
        };
      }
    },
    /**
     * Stops the selected failed control even after the entry has been quarantined.
     * @returns Confirmed shutdown, with exact identity proof when a controller was released.
     * @throws
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     */
    async stopControl(
      provider: IProviderId,
      nativeId?: string,
      controlScope?: string,
      requiresQuiescence = false,
    ): Promise<IStoppedControl | void> {
      const entry = entries.get(provider);
      if (!entry?.adapter) return;
      const stoppingKey = JSON.stringify([
        nativeId ?? null,
        controlScope ?? null,
        requiresQuiescence,
      ]);
      const existing = entry.stopping.get(stoppingKey);
      if (existing) return existing;
      const stop = (async () => {
        // register ownership before a native close can synchronously report unavailability
        await Promise.resolve();
        try {
          return await bounded((call) =>
            entry.adapter!.stopControl(nativeId, {
              ...call,
              ...(controlScope ? { controlScope } : {}),
              ...(requiresQuiescence ? { requiresQuiescence } : {}),
            }),
          );
        } catch (cause) {
          // a failed Claude group proof belongs to its retained controller, not its peers
          if (provider === 'claude' && nativeId !== undefined) throw normalizeProviderError(cause);
          entry.failure ??= normalizeProviderError(cause);
          throw entry.failure;
        } finally {
          entry.stopping.delete(stoppingKey);
        }
      })();
      entry.stopping.set(stoppingKey, stop);
      return stop;
    },
    /**
     * Cancels provider work and confirms cleanup, including construction that is still pending.
     * @returns Confirmed shutdown of every adapter that this registry started.
     * @throws
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    close(): Promise<void> {
      isClosing = true;
      return (closing ??= (async () => {
        lifetime.abort();
        const results = await Promise.allSettled(
          [...entries.values()].map(async (entry) => {
            if (entry.opening && !entry.adapter) {
              await bounded(async () => {
                try {
                  entry.adapter = await entry.opening;
                } catch (cause) {
                  if (isCleanupUnconfirmed(cause)) throw cause;
                }
              });
            }
            if (entry.adapter) await closeEntry(entry);
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw normalizeProviderError(failed.reason);
      })());
    },
  };
};
