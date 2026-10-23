import { Exception, isException } from 'jg-exception';
import { abortable, createDeadline } from 'jg-utilities';
import { z } from 'zod';

import {
  HistoryItemSchema,
  MAX_PROVIDERS,
  ApprovalPresentationSchema,
  AccountObservationSchema,
  LoginObservationSchema,
  NativeControlResultSchema,
  MAX_MCP_CATALOG_BYTES,
  ProviderCapabilitySetSchema,
  ProviderIdSchema,
  ProviderStatusSchema,
  ProviderModelPageSchema,
  SessionConfigurationSchema,
  UsageSnapshotSchema,
  type IManagedThread,
  type IProviderCapabilities,
  type IProviderCapabilitySet,
  type IProviderId,
  type IProviderStatus,
} from '../../contracts/index.js';
import { NativeIdSchema } from '../../contracts/identities/index.js';
import { MAX_FRAME_BYTES } from '../../ipc/index.js';
import { nativeProvenance } from '../../sessions/evidence/index.js';
import { ApprovalRecordSchema } from '../../store/control/index.js';
import {
  ProviderMcpServerPageSchema,
  ProviderMcpToolsSchema,
  ProviderMcpResourcesSchema,
} from '../extensions/index.js';
import {
  ProviderInspectionSchema,
  ProviderThreadSchema,
  ProviderSkillsSchema,
  type IAgentProvider,
  type IAgentProviderEvents,
  type IProviderCall,
} from '../index.js';

import type {
  IBoundAgentProvider,
  IProviderRegistration,
  IProviderRegistryEvents,
} from './types.js';
import { capabilityUnavailable, normalizeProviderError } from './utilities.js';
import {
  parseProviderObservation,
  parseProviderOutcome,
  rejectProviderResponse,
  validateProviderHistory,
} from './validations.js';

type IProviderEntry = {
  registration: IProviderRegistration;
  opening?: Promise<IAgentProvider>;
  ready?: Promise<IBoundAgentProvider>;
  adapter?: IAgentProvider;
  closing?: Promise<void>;
  failure?: unknown;
  stopping: Map<string | undefined, Promise<void>>;
};

const CleanupSchema = z.object({ cleanupUnconfirmed: z.literal(true) });

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
      fork: unavailable,
      archive: unavailable,
      unarchive: unavailable,
      compact: unavailable,
      revert: unavailable,
      configuration: unavailable,
      account: unavailable,
      mcpServers: unavailable,
      mcpTools: unavailable,
      mcpResources: unavailable,
      skillsReload: unavailable,
      mcpReload: unavailable,
      mcpReconnect: unavailable,
      mcpSetEnabled: unavailable,
      mcpLogin: unavailable,
      pluginsReload: unavailable,
      accountLogin: unavailable,
      accountLoginCancel: unavailable,
      accountLogout: unavailable,
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
 * Registers trusted factories and starts only the provider explicitly selected by an operation.
 * @returns Runtime-owned routing, observations and confirmed adapter cleanup.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const createProviderRegistry = (
  registrations: IProviderRegistration[],
  allowedRoots: string[],
  runtimeEpoch: string,
) => {
  const entries = new Map<IProviderId, IProviderEntry>();
  const lifetime = new AbortController();
  let handlers: IProviderRegistryEvents | undefined;
  let closing: Promise<void> | undefined;
  let isClosing = false;
  if (registrations.length > MAX_PROVIDERS)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  for (const registration of registrations) {
    const id = ProviderIdSchema.safeParse(registration.factory.id);
    if (!id.success || entries.has(id.data) || typeof registration.factory.create !== 'function')
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    entries.set(id.data, { registration, stopping: new Map() });
  }

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
        throw normalizeProviderError(cause, entry.registration.isBuiltIn);
      }
    })());

  /** Quarantines malformed provider evidence without throwing into a native event emitter. */
  const quarantine = (entry: IProviderEntry, cause: unknown): void => {
    entry.failure ??= normalizeProviderError(cause, entry.registration.isBuiltIn);
    handlers?.unavailable(entry.registration.factory.id);
    if (entry.adapter) void closeEntry(entry).catch(() => undefined);
  };

  /** Binds identity and validates only the normalized evidence consumed by the runtime. */
  const eventsFor = (entry: IProviderEntry): IAgentProviderEvents => {
    const provider = entry.registration.factory.id;
    const deliver = (operation: () => void): void => {
      if (entry.failure || isClosing) return;
      try {
        operation();
      } catch (cause) {
        quarantine(entry, cause);
      }
    };
    return {
      observe: (input) =>
        deliver(() => {
          const observation = parseProviderObservation(input);
          if (observation.provider !== provider) rejectProviderResponse();
          handlers?.observe(provider, observation);
        }),
      item: (nativeId, item, complete, replacedIds) =>
        deliver(() => {
          const normalized = HistoryItemSchema.parse(item);
          const observed = normalized.provenance;
          normalized.provenance = nativeProvenance(normalized.kind, observed.nativeInputId);
          if (observed.origin === 'system' && observed.source === 'native-kind')
            normalized.provenance = {
              ...normalized.provenance,
              origin: 'system',
              source: 'native-kind',
            };
          handlers?.item(
            provider,
            NativeIdSchema.parse(nativeId),
            normalized,
            z.boolean().parse(complete),
            replacedIds === undefined
              ? undefined
              : z.array(NativeIdSchema).max(128).parse(replacedIds),
          );
        }),
      gap: (nativeId) => deliver(() => handlers?.gap(provider, NativeIdSchema.parse(nativeId))),
      delta: (nativeId, turnId, itemId, text) =>
        deliver(() => {
          handlers?.delta(
            provider,
            NativeIdSchema.parse(nativeId),
            NativeIdSchema.parse(turnId),
            NativeIdSchema.parse(itemId),
            z.string().max(MAX_FRAME_BYTES).parse(text),
          );
        }),
      prompt: (prompt) =>
        deliver(() => {
          if (
            prompt.provider !== provider ||
            typeof prompt.reply !== 'function' ||
            typeof prompt.reject !== 'function' ||
            typeof prompt.validate !== 'function'
          )
            rejectProviderResponse();
          NativeIdSchema.parse(prompt.nativeThreadId);
          NativeIdSchema.parse(prompt.nativeTurnId);
          ApprovalRecordSchema.shape.requestId.parse(prompt.requestId);
          if (Buffer.byteLength(prompt.fingerprint) > MAX_FRAME_BYTES) rejectProviderResponse();
          const normalized = {
            ...prompt,
            presentation: ApprovalPresentationSchema.parse(prompt.presentation),
            validate(response: Parameters<typeof prompt.validate>[0]) {
              try {
                return prompt.validate(response);
              } catch (cause) {
                throw normalizeProviderError(cause, entry.registration.isBuiltIn);
              }
            },
            async reply(response: unknown): Promise<void> {
              try {
                await bounded(() => prompt.reply(response), lifetime.signal);
              } catch (cause) {
                throw normalizeProviderError(cause, entry.registration.isBuiltIn);
              }
            },
            async reject(): Promise<void> {
              try {
                await bounded(() => prompt.reject(), lifetime.signal);
              } catch (cause) {
                throw normalizeProviderError(cause, entry.registration.isBuiltIn);
              }
            },
          };
          if (handlers) handlers.prompt(provider, normalized);
          else void normalized.reject().catch((cause) => quarantine(entry, cause));
        }),
      outcome: (input, thread) =>
        deliver(() => {
          const metadata = thread === undefined ? undefined : ProviderThreadSchema.parse(thread);
          const outcome = parseProviderOutcome(input, metadata?.nativeLineage);
          if (outcome.kind === 'created' || outcome.kind === 'resumed') {
            if (
              !metadata ||
              metadata.nativeState !== 'idle' ||
              (outcome.kind === 'created' && outcome.nativeId !== metadata.nativeId) ||
              (outcome.kind === 'resumed' && outcome.nativeState !== metadata.nativeState)
            )
              rejectProviderResponse();
          }
          if (
            (outcome.kind === 'reverted' && (!metadata || metadata.nativeState !== 'idle')) ||
            (outcome.kind === 'unarchived' &&
              (!metadata || !['idle', 'notLoaded'].includes(metadata.nativeState)))
          )
            rejectProviderResponse();
          handlers?.outcome(provider, outcome, metadata);
        }),
      unavailable: (nativeId) =>
        deliver(() =>
          handlers?.unavailable(
            provider,
            nativeId === undefined ? undefined : NativeIdSchema.parse(nativeId),
          ),
        ),
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
            entry.registration.factory.create({
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
            throw normalizeProviderError(cause, entry.registration.isBuiltIn);
          }
        };
        const invokeControl = async <T>(
          operation: (call: IProviderCall) => Promise<T>,
        ): Promise<T> =>
          invoke(async (call) => {
            try {
              return await operation(call);
            } catch (cause) {
              if (
                cause instanceof z.ZodError ||
                (isException(cause) && cause.cause instanceof z.ZodError)
              )
                quarantine(entry, cause);
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
            if (entry.failure) return false;
            try {
              return z.boolean().parse(adapter.isAvailable);
            } catch (cause) {
              quarantine(entry, cause);
              return false;
            }
          },
          readCapabilities: (nativeId) =>
            invoke(async (call) => {
              const result = await adapter.readCapabilities(nativeId, call);
              if (Buffer.byteLength(JSON.stringify(result)) > 65_536) capabilityUnavailable();
              return ProviderCapabilitySetSchema.parse(result);
            }),
          readLogin: (requestId) =>
            invoke(async (call) =>
              LoginObservationSchema.parse(await adapter.readLogin(requestId, call)),
            ),
          controlAccount: (requestId, command, loginRequestId) =>
            invokeControl(async (call) =>
              NativeControlResultSchema.parse(
                await adapter.controlAccount(requestId, command, loginRequestId, call),
              ),
            ),
          controlExtensions: (requestId, nativeId, workspaceRoot, command) =>
            invokeControl(async (call) =>
              NativeControlResultSchema.parse(
                await adapter.controlExtensions(requestId, nativeId, workspaceRoot, command, call),
              ),
            ),
          readAccount: () =>
            invoke(async (call) => {
              const result = AccountObservationSchema.parse(await adapter.readAccount(call));
              if (result.provider !== provider) rejectProviderResponse();
              return result;
            }),
          readMcpServers: (nativeId, limit, cursor) =>
            invoke(async (call) => {
              const raw = await adapter.readMcpServers(nativeId, limit, cursor, call);
              if (Buffer.byteLength(JSON.stringify(raw)) > MAX_MCP_CATALOG_BYTES)
                rejectProviderResponse();
              const page = ProviderMcpServerPageSchema.parse(raw);
              if (page.data.length > limit) rejectProviderResponse();
              return page;
            }),
          readMcpTools: (nativeId, serverName) =>
            invoke(async (call) => {
              const raw = await adapter.readMcpTools(nativeId, serverName, call);
              if (Buffer.byteLength(JSON.stringify(raw)) > MAX_MCP_CATALOG_BYTES)
                rejectProviderResponse();
              return ProviderMcpToolsSchema.parse(raw);
            }),
          readMcpResources: (nativeId, serverName) =>
            invoke(async (call) => {
              const raw = await adapter.readMcpResources(nativeId, serverName, call);
              if (Buffer.byteLength(JSON.stringify(raw)) > MAX_MCP_CATALOG_BYTES)
                rejectProviderResponse();
              return ProviderMcpResourcesSchema.parse(raw);
            }),
          readHistory: (command) =>
            invoke(async (call) =>
              validateProviderHistory(await adapter.readHistory(command, call), command, provider),
            ),
          readModels: (command) =>
            invoke(async (call) => {
              const page = ProviderModelPageSchema.parse(await adapter.readModels(command, call));
              if (page.provider !== provider || page.data.length > command.limit)
                rejectProviderResponse();
              return page;
            }),
          forkThread: (requestId, nativeId, workspaceRoot) =>
            invokeControl(async (call) => {
              const parsed = ProviderThreadSchema.parse(
                await adapter.forkThread(requestId, nativeId, workspaceRoot, call),
              );
              if (
                parsed.nativeState !== 'idle' ||
                parsed.nativeId === nativeId ||
                parsed.nativeLineage?.forkedFromId !== nativeId
              ) {
                quarantine(
                  entry,
                  new Exception('The HQ provider integration failed', {
                    code: 'JG_AGENT_HQ_PROVIDER_FAILED',
                    data: { kind: 'agent-unavailable' },
                  }),
                );
                throw entry.failure;
              }
              return parsed;
            }),
          archiveThread: (requestId, nativeId) =>
            invokeControl((call) => adapter.archiveThread(requestId, nativeId, call)),
          unarchiveThread: (requestId, nativeId) =>
            invokeControl(async (call) => {
              const thread = ProviderThreadSchema.refine(
                (thread) =>
                  thread.nativeId === nativeId &&
                  ['idle', 'notLoaded'].includes(thread.nativeState),
              ).parse(await adapter.unarchiveThread(requestId, nativeId, call));
              return thread;
            }),
          revertThread: (requestId, nativeId, beforeTurnId) =>
            invokeControl(async (call) => {
              const thread = ProviderThreadSchema.refine(
                (thread) => thread.nativeId === nativeId && thread.nativeState === 'idle',
              ).parse(await adapter.revertThread(requestId, nativeId, beforeTurnId, call));
              return thread;
            }),
          compactThread: (requestId, nativeId) =>
            invokeControl(async (call) =>
              z
                .object({ id: NativeIdSchema.nullable() })
                .parse(await adapter.compactThread(requestId, nativeId, call)),
            ),
          inspectThread: (nativeId, workspaceRoot) =>
            invokeControl(async (call) => {
              const result = ProviderInspectionSchema.parse(
                await adapter.inspectThread(nativeId, workspaceRoot, call),
              );
              if (result.thread.provider !== provider || result.thread.nativeId !== nativeId) {
                quarantine(
                  entry,
                  new Exception('The HQ provider integration failed', {
                    code: 'JG_AGENT_HQ_PROVIDER_FAILED',
                    data: { kind: 'agent-unavailable' },
                  }),
                );
                throw entry.failure;
              }
              return result;
            }),
          readConfiguration: (command, nativeId) =>
            invoke(async (call) => {
              const result = SessionConfigurationSchema.parse(
                await adapter.readConfiguration(command, nativeId, call),
              );
              if (
                result.provider !== provider ||
                result.nativeId !== (nativeId ?? null) ||
                result.workingDirectory !== command.workspaceRoot ||
                (result.choices !== null && result.choices.length > command.limit)
              )
                rejectProviderResponse();
              return result;
            }),
          readUsage: () =>
            invoke(async (call) => {
              const result = UsageSnapshotSchema.parse(await adapter.readUsage(call));
              if (result.provider !== provider) rejectProviderResponse();
              return result;
            }),
          readSkills: (nativeId, workspaceRoot) =>
            invoke(async (call) => {
              const result = await adapter.readSkills(nativeId, workspaceRoot, call);
              if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) capabilityUnavailable();
              return ProviderSkillsSchema.parse(result);
            }),
          formatSkill(skill, argumentsText) {
            try {
              return z.string().max(65_536).parse(adapter.formatSkill(skill, argumentsText));
            } catch (cause) {
              throw normalizeProviderError(cause, entry.registration.isBuiltIn);
            }
          },
          startThread: (requestId, workspaceRoot, settings) =>
            invokeControl(async (call) => {
              const parsed = ProviderThreadSchema.safeParse(
                await adapter.startThread(requestId, workspaceRoot, settings, call),
              );
              if (!parsed.success || parsed.data.nativeState !== 'idle') {
                quarantine(
                  entry,
                  parsed.success
                    ? new Exception('The HQ provider integration failed', {
                        code: 'JG_AGENT_HQ_PROVIDER_FAILED',
                        data: { kind: 'agent-unavailable' },
                      })
                    : parsed.error,
                );
                throw entry.failure;
              }
              return parsed.data;
            }),
          resumeThread: (requestId, nativeId, workspaceRoot, name, settings) =>
            invokeControl(async (call) => {
              const parsed = ProviderThreadSchema.safeParse(
                await adapter.resumeThread(
                  requestId,
                  nativeId,
                  workspaceRoot,
                  name,
                  settings,
                  call,
                ),
              );
              if (
                !parsed.success ||
                parsed.data.nativeId !== nativeId ||
                parsed.data.nativeState !== 'idle'
              ) {
                quarantine(
                  entry,
                  parsed.success
                    ? new Exception('The HQ provider integration failed', {
                        code: 'JG_AGENT_HQ_PROVIDER_FAILED',
                        data: { kind: 'agent-unavailable' },
                      })
                    : parsed.error,
                );
                throw entry.failure;
              }
              return parsed.data;
            }),
          nameThread: (requestId, nativeId, name) =>
            invokeControl((call) => adapter.nameThread(requestId, nativeId, name, call)),
          validateInput: (nativeId, input) =>
            invoke((call) => adapter.validateInput(nativeId, input, call)),
          startTurn: (requestId, nativeId, text, skill, settings, files) =>
            invokeControl(async (call) =>
              z
                .object({ id: NativeIdSchema })
                .parse(
                  await adapter.startTurn(requestId, nativeId, text, skill, settings, files, call),
                ),
            ),
          steer: (requestId, nativeId, expectedTurnId, text) =>
            invokeControl(async (call) =>
              NativeIdSchema.parse(
                await adapter.steer(requestId, nativeId, expectedTurnId, text, call),
              ),
            ),
          interrupt: (requestId, nativeId, nativeTurnId) =>
            invokeControl((call) => adapter.interrupt(requestId, nativeId, nativeTurnId, call)),
          cleanThread: (requestId, nativeId) =>
            invokeControl((call) => adapter.cleanThread(requestId, nativeId, call)),
          releaseThread: (requestId, nativeId) =>
            invokeControl((call) => adapter.releaseThread(requestId, nativeId, call)),
          prepareShutdown: (nativeId) => invoke((call) => adapter.prepareShutdown(nativeId, call)),
          stopControl: (nativeId) => invoke((call) => adapter.stopControl(nativeId, call)),
          close: () => closeEntry(entry),
        } satisfies IBoundAgentProvider;
      } catch (cause) {
        entry.failure ??= normalizeProviderError(cause, entry.registration.isBuiltIn);
        throw entry.failure;
      }
    })());
  };

  return {
    get,
    /** Quarantines one provider after a source-specific lifecycle gap or invalid control response. */
    quarantine(provider: IProviderId, cause: unknown): void {
      const entry = entries.get(provider);
      if (entry && !entry.failure) quarantine(entry, cause);
    },
    /** Installs runtime-owned callbacks without constructing any adapter. */
    setEvents(events: IProviderRegistryEvents): void {
      handlers = events;
    },
    /** @returns Bounded connection observations without native startup or inference. */
    statuses(): IProviderStatus[] {
      return [...entries].map(([provider, entry]) => {
        try {
          return ProviderStatusSchema.parse({
            provider,
            state: entry.failure ? 'unavailable' : (entry.adapter?.state ?? 'idle'),
            version: entry.adapter?.version ?? null,
          });
        } catch (cause) {
          quarantine(entry, cause);
          return { provider, state: 'unavailable' as const, version: null };
        }
      });
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
    async readUsage(
      provider: IProviderId,
    ): Promise<import('../../contracts/index.js').IUsageSnapshot> {
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
     * @returns Confirmed shutdown of that provider's affected control connection.
     * @throws
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async stopControl(provider: IProviderId, nativeId?: string): Promise<void> {
      const entry = entries.get(provider);
      if (!entry?.adapter) return;
      const existing = entry.stopping.get(nativeId);
      if (existing) return existing;
      const stop = (async () => {
        // register ownership before a native close can synchronously report unavailability
        await Promise.resolve();
        try {
          await bounded((call) => entry.adapter!.stopControl(nativeId, call));
        } catch (cause) {
          entry.failure ??= normalizeProviderError(cause, entry.registration.isBuiltIn);
          throw entry.failure;
        } finally {
          entry.stopping.delete(nativeId);
        }
      })();
      entry.stopping.set(nativeId, stop);
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
                  if (isException(cause) && CleanupSchema.safeParse(cause.data).success)
                    throw cause;
                }
              });
            }
            if (entry.adapter) await closeEntry(entry);
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw normalizeProviderError(failed.reason, false);
      })());
    },
  };
};
