import { randomUUID } from 'node:crypto';
import { Exception, isException } from 'jg-exception';
import { delay, isEqual } from 'jg-utilities';
import { z } from 'zod';

import type { IProviderAgentTools } from '../../../agent-tools/index.js';
import { DISPATCH_OUTPUT_SCHEMA } from '../../../contracts/collaboration/index.js';

import type {
  IConfigurationRequest,
  ISessionSettings,
  ITurnSettings,
  IExtensionControlCommand,
  INativeControlResult,
} from '../../../contracts/index.js';
import type { IProviderInputFile } from '../../inputs/index.js';
import { capabilityUnavailable } from '../../registry/index.js';
import { toClaudeConfiguration } from '../configuration/index.js';
import { createClaudeExtensions } from '../extensions/index.js';

import { createClaudeRpc } from '../rpc.js';
import { ClaudeInitializeSchema } from '../types.js';

import type { IClaudeControlEvents, IClaudeSession } from './types.js';
import { receiveClaudeMessage } from './stream.js';
import { toClaudeSkills } from './skills.js';

// a session idle this long since its last turn ended gives up its process until it is needed
const IDLE_STOP_SECONDS = 3_600;

/**
 * Owns one persistent native CLI per explicitly controlled Claude session.
 * @returns Controls whose processes outlive client connections and stop at runtime shutdown.
 */
export const createClaudeControl = (
  additionalDirectories: string[] = [],
  agentTools?: IProviderAgentTools,
) => {
  const sessions = new Map<string, IClaudeSession>();
  const extensionRequests = new Map<
    string,
    { nativeId: string; kind: IExtensionControlCommand['kind'] }
  >();
  // calls running against each session, which a session never parks during
  const activeCalls = new Map<string, number>();
  let events: IClaudeControlEvents | undefined;
  let isClosing = false;
  const unavailable: () => never = () => {
    throw new Exception('The Claude integration failed', {
      code: 'JG_AGENT_HQ_CLAUDE_FAILED',
      data: { kind: 'agent-unavailable' },
    });
  };
  const conflict: () => never = () => {
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: {
        kind: 'state-conflict',
      },
    });
  };
  const get = (id: string, isParkedAllowed = false): IClaudeSession => {
    const session = sessions.get(id);
    if (
      !session ||
      session.isClosing ||
      !(session.connection?.isAvailable || (isParkedAllowed && session.parked))
    )
      unavailable();
    return session;
  };
  const countOpen = (): number =>
    [...sessions.values()].filter((session) => !session.parked).length;
  const hasExtensionRequest = (nativeId: string): boolean =>
    [...extensionRequests.values()].some((request) => request.nativeId === nativeId);
  /** Stops the wait that parks an idle session, as a turn or a stop does. */
  const cancelIdleStop = (session: IClaudeSession): void => {
    session.idleStop?.abort();
    session.idleStop = undefined;
  };
  /** Parks the session once it stays idle for the whole period, restarting any earlier wait. */
  const scheduleIdleStop = (session: IClaudeSession): void => {
    cancelIdleStop(session);
    if (isClosing || session.isClosing) return;
    const idleStop = new AbortController();
    session.idleStop = idleStop;
    void delay(IDLE_STOP_SECONDS, { signal: idleStop.signal }).then(
      () => park(session),
      () => undefined,
    );
  };
  /**
   * Reads an idle session's native settings once, then closes its process and releases its agent
   * bridge. The session stays idle and records nothing; a call that arrives first keeps the process.
   */
  const park = async (session: IClaudeSession): Promise<void> => {
    const connection = session.connection;
    if (
      isClosing ||
      session.isClosing ||
      session.input ||
      session.transition ||
      !connection?.isAvailable
    )
      return;
    if (activeCalls.has(session.id) || session.requests.size || hasExtensionRequest(session.id)) {
      scheduleIdleStop(session);
      return;
    }
    session.transition = (async () => {
      let configuration: unknown;
      try {
        configuration = await connection.requestControl({ subtype: 'get_settings' });
      } catch {
        scheduleIdleStop(session);
        return;
      }
      if (isClosing || session.isClosing || activeCalls.has(session.id)) {
        scheduleIdleStop(session);
        return;
      }
      // set before closing, so the connection's close isn't reported as a lost process
      session.parked = {
        configuration,
        agents: connection.initialization.agents,
        permissionMode: connection.initialization.current_permission_mode,
      };
      try {
        await connection.close();
        await session.agentBridge?.release();
        session.agentBridge = undefined;
        session.connection = undefined;
      } catch {
        session.parked = undefined;
        events?.unavailable(session.id);
      }
    })().finally(() => {
      session.transition = undefined;
    });
    await session.transition;
  };
  /**
   * Reopens a parked session with `--resume`, its kept settings and a new agent bridge; a session
   * that fails to reopen is unavailable, as one whose process was lost.
   */
  const reopen = async (
    session: IClaudeSession,
    signal?: AbortSignal,
    toReopenedSettings?: (settings: ISessionSettings) => ISessionSettings,
  ): Promise<void> => {
    if (isClosing || countOpen() >= 32) conflict();
    if (toReopenedSettings) session.settings = toReopenedSettings(session.settings);
    session.parked = undefined;
    session.scope = randomUUID();
    session.opening = start(session, session.hasInput, undefined, signal);
    try {
      await session.opening;
    } catch (error) {
      events?.unavailable(session.id);
      throw error;
    }
  };
  /**
   * Runs one call on a session after any park or reopen in progress, never letting it park
   * meanwhile. A parked session reopens first when the call needs its process, with the settings
   * `toReopenedSettings` selects, and otherwise answers from what it kept.
   */
  const withSession = async <T>(
    nativeId: string,
    isProcessNeeded: boolean,
    call: (session: IClaudeSession) => Promise<T>,
    signal?: AbortSignal,
    toReopenedSettings?: (settings: ISessionSettings) => ISessionSettings,
  ): Promise<T> => {
    activeCalls.set(nativeId, (activeCalls.get(nativeId) ?? 0) + 1);
    try {
      let session = sessions.get(nativeId);
      while (session?.transition) {
        await session.transition.catch(() => undefined);
        session = sessions.get(nativeId);
      }
      if (session?.parked && isProcessNeeded && !session.isClosing) {
        const parked = session;
        parked.transition = reopen(parked, signal, toReopenedSettings).finally(() => {
          parked.transition = undefined;
        });
        await parked.transition;
      }
      return await call(get(nativeId, !isProcessNeeded));
    } finally {
      const count = (activeCalls.get(nativeId) ?? 1) - 1;
      if (count > 0) activeCalls.set(nativeId, count);
      else activeCalls.delete(nativeId);
    }
  };
  /** Refreshes optional command/agent metadata after native configuration changes. */
  const refreshCatalog = async (session: IClaudeSession): Promise<void> => {
    session.skills = null;
    session.connection!.initialization.agents = undefined;
    try {
      const initialized = ClaudeInitializeSchema.parse(
        await session.connection!.requestControl({ subtype: 'initialize' }),
      );
      const inventory = toClaudeSkills({ skills: initialized.commands });
      if (Buffer.byteLength(JSON.stringify(inventory.skills)) <= 1_048_576)
        session.skills = { ...inventory, observedAt: Date.now() };
      session.connection!.initialization.agents = initialized.agents;
    } catch {
      /* optional metadata stays unavailable after an acknowledged native reload */
    }
  };
  /** Validates the exact control response and refreshes catalogs without starting inference. */
  const completeExtension = async (
    requestId: string,
    raw: unknown,
  ): Promise<INativeControlResult> => {
    const request = extensionRequests.get(requestId);
    if (!request) conflict();
    const plugins =
      request.kind === 'plugins-reload'
        ? z
            .object({ held: z.boolean().optional(), error_count: z.number().int().nonnegative() })
            .parse(raw)
        : null;
    extensionRequests.delete(requestId);
    if (plugins?.held) return { state: 'held', completion: 'completed' };
    if (request.kind === 'skills-reload' || request.kind === 'plugins-reload')
      await refreshCatalog(get(request.nativeId));
    return {
      state: 'applied',
      completion: plugins && plugins.error_count > 0 ? 'failed' : 'completed',
    };
  };
  /**
   * Checks native format selection; the HQ envelope can be installed at an idle restart.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   */
  const validateInput = (nativeId: string, settings: ITurnSettings): void => {
    if (
      settings.outputSchema &&
      !isEqual(settings.outputSchema, get(nativeId, true).settings.outputSchema) &&
      !isEqual(settings.outputSchema, DISPATCH_OUTPUT_SCHEMA)
    )
      capabilityUnavailable();
  };
  /**
   * Starts a session's native process and permits control only after native idle initialization,
   * beginning its idle period.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const start = async (
    session: IClaudeSession,
    isResume: boolean,
    forkSourceNativeId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> => {
    const nativeId = session.id;
    session.agentBridge = await agentTools?.mcp(nativeId);
    try {
      const connection = await createClaudeRpc(
        (reason) => {
          if (reason !== 'unavailable' || session.isClosing || session.parked) return;
          if (session.input) {
            clearTimeout(session.input.timer);
            session.input.reject(
              new Exception('The Claude integration failed', {
                code: 'JG_AGENT_HQ_CLAUDE_FAILED',
                data: {
                  kind: 'agent-unavailable',
                },
              }),
            );
          }
          events?.unavailable(session.id);
        },
        {
          nativeId,
          workspaceRoot: session.workspaceRoot,
          additionalDirectories,
          isResume,
          settings: session.settings,
          ...(session.agentBridge
            ? {
                mcpServers: {
                  [session.agentBridge.serverName]: session.agentBridge.configuration,
                },
              }
            : {}),
          ...(forkSourceNativeId ? { forkSourceNativeId } : {}),
          receive: (raw) => {
            const hadInput = session.input !== undefined;
            receiveClaudeMessage(session, raw, events);
            // the end of a turn starts the session's idle period
            if (hadInput && !session.input) scheduleIdleStop(session);
          },
          lateResponse(id, result, error) {
            if (extensionRequests.get(id)?.nativeId === nativeId) {
              if (error !== undefined) {
                extensionRequests.delete(id);
                events?.outcome({ kind: 'failed', requestId: id, failure: 'agent-unavailable' });
                return;
              }
              void (async () => {
                try {
                  const resultState = await completeExtension(id, result);
                  events?.outcome({ kind: 'control-accepted', requestId: id, ...resultState });
                } catch {
                  events?.unavailable(nativeId);
                  await session.connection?.close();
                }
              })().catch(() => events?.unavailable(nativeId));
              return;
            }
            if (!/^[a-f0-9-]{36}:(name|interrupt)$/.test(id)) return;
            if (error !== undefined)
              events?.outcome({
                kind: 'failed',
                requestId: id,
                failure: 'agent-unavailable',
              });
            else
              events?.outcome({
                kind: id.endsWith(':name') ? 'renamed' : 'interrupt-accepted',
                requestId: id,
              });
          },
        },
        undefined,
        signal,
      );
      session.connection = connection;
      if (connection.initialization.session_state !== 'idle') {
        await connection.close();
        unavailable();
      }
      // unsupported optional metadata disables the catalog, without disabling native controls
      session.skills = null;
      try {
        const skills = toClaudeSkills({ skills: connection.initialization.commands });
        if (Buffer.byteLength(JSON.stringify(skills.skills)) <= 1_048_576)
          session.skills = { ...skills, observedAt: connection.initializedAt };
      } catch {
        /* catalog availability is reported independently */
      }
      delete connection.initialization.commands;
      scheduleIdleStop(session);
    } catch (error) {
      await session.agentBridge?.release();
      throw error;
    }
  };
  /**
   * Records ownership before startup and permits control only after native idle initialization.
   * Parked sessions don't count toward the 32 open processes.
   * @returns The process-bound native identity and workspace.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const open = async (
    nativeId: string,
    workspaceRoot: string,
    isResume: boolean,
    forkSourceNativeId?: string,
    settings: ISessionSettings = {},
    signal?: AbortSignal,
  ) => {
    if (
      isClosing ||
      sessions.has(nativeId) ||
      countOpen() >= 32 ||
      !z.uuid().safeParse(nativeId).success
    )
      conflict();
    const session: IClaudeSession = {
      id: nativeId,
      workspaceRoot,
      settings: { ...settings },
      scope: randomUUID(),
      isClosing: false,
      hasInput: isResume || forkSourceNativeId !== undefined,
      opening: Promise.resolve(),
      previews: new Map(),
      requests: new Map(),
    };
    sessions.set(nativeId, session);
    session.opening = start(session, isResume, forkSourceNativeId, signal);
    await session.opening;
    return { id: nativeId, cwd: workspaceRoot, status: { type: 'idle' as const } };
  };
  return {
    /**
     * Applies one supported native extension command to an idle owned session, reopening a parked one.
     * @returns Native acknowledgement, preserving held plugin reloads explicitly.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async controlExtensions(
      requestId: string,
      nativeId: string,
      workspaceRoot: string,
      command: IExtensionControlCommand,
    ): Promise<INativeControlResult> {
      if (get(nativeId, true).workspaceRoot !== workspaceRoot) conflict();
      if (command.kind === 'mcp-login' || command.kind === 'mcp-reload') capabilityUnavailable();
      return withSession(nativeId, true, async (session) => {
        if (session.input || session.requests.size || extensionRequests.size >= 32) conflict();
        extensionRequests.set(requestId, { nativeId, kind: command.kind });
        const body =
          command.kind === 'skills-reload'
            ? { subtype: 'reload_skills' }
            : command.kind === 'plugins-reload'
              ? { subtype: 'reload_plugins', hold_on_cache_impact: true }
              : command.kind === 'mcp-reconnect'
                ? { subtype: 'mcp_reconnect', serverName: command.serverName }
                : {
                    subtype: 'mcp_toggle',
                    serverName: command.serverName,
                    enabled: command.isEnabled,
                  };
        try {
          return await completeExtension(
            requestId,
            await session.connection!.requestControl(body, requestId),
          );
        } catch (error) {
          if (
            isException(error) &&
            z.object({ nativeRejection: z.literal(true) }).safeParse(error.data).success
          )
            extensionRequests.delete(requestId);
          throw error;
        }
      });
    },
    get isAvailable() {
      return !isClosing;
    },
    /**
     * Reads native MCP status for this exact controlled session, reopening a parked one.
     * @returns The native server page.
     * @throws
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    readMcpServers(nativeId: string, limit: number, cursor?: string) {
      return withSession(nativeId, true, (session) =>
        createClaudeExtensions(session.connection!).readMcpServers(limit, cursor),
      );
    },
    /**
     * Reads native tool metadata for one configured session server, reopening a parked one.
     * @returns The server's native tool metadata.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    readMcpTools(nativeId: string, serverName: string) {
      return withSession(nativeId, true, (session) =>
        createClaudeExtensions(session.connection!).readMcpTools(serverName),
      );
    },
    /**
     * Reports the native resource catalog, reopening a parked session.
     * @returns An explicit unsupported native resource catalog observation.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    readMcpResources(nativeId: string) {
      return withSession(nativeId, true, async (session) =>
        createClaudeExtensions(session.connection!).readMcpResources(),
      );
    },
    get version() {
      return (
        [...sessions.values()].find((session) => session.connection)?.connection?.version ?? null
      );
    },
    get state(): 'idle' | 'ready' | 'unavailable' {
      return isClosing
        ? 'unavailable'
        : [...sessions.values()].some(
              (session) => session.connection?.isAvailable && !session.isClosing,
            )
          ? 'ready'
          : countOpen()
            ? 'unavailable'
            : 'idle';
    },
    /**
     * Installs the runtime-owned evidence channel.
     */
    setEvents(handlers: IClaudeControlEvents): void {
      events = handlers;
    },
    /**
     * Starts an idle native session with normal local instructions and settings.
     * @returns The exact native session identity and workspace.
     * @throws
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async startThread(
      _requestId: string,
      workspaceRoot: string,
      settings: ISessionSettings = {},
      signal?: AbortSignal,
    ) {
      return open(randomUUID(), workspaceRoot, false, undefined, settings, signal);
    },
    /**
     * Uses native resume/fork flags while keeping the source session untouched.
     * @returns The independently verified native fork and its source.
     * @throws
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async forkThread(
      _requestId: string,
      sourceNativeId: string,
      workspaceRoot: string,
      signal?: AbortSignal,
    ) {
      return {
        ...(await open(randomUUID(), workspaceRoot, true, sourceNativeId, {}, signal)),
        forkedFromId: sourceNativeId,
      };
    },
    /**
     * Loads a confirmed handoff and verifies its native session identity.
     * @returns The native idle state after the session-id fence succeeds.
     * @throws
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async resumeThread(
      _requestId: string,
      nativeId: string,
      workspaceRoot: string,
      name: string,
      settings: ISessionSettings = {},
      signal?: AbortSignal,
    ) {
      const result = await open(nativeId, workspaceRoot, true, undefined, settings, signal);
      if (signal?.aborted) unavailable();
      // the native session-id fence verifies the exact resumed conversation before control is granted
      await get(nativeId).connection!.requestControl({
        subtype: 'rename_session',
        title: name,
        source: 'host',
        session_id: nativeId,
      });
      return result;
    },
    /**
     * Reads the native startup command list, which includes explicit-only skills.
     * @returns The native inventory with unavailable fields left explicit.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async readSkills(nativeId: string) {
      return withSession(nativeId, false, async (session) => session.skills ?? unavailable());
    },
    /**
     * Reads settings from the exact owned native process rather than a global configuration file.
     * @returns Known native fields and a bounded agent inventory page.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     */
    async readConfiguration(command: IConfigurationRequest, nativeId: string) {
      return withSession(nativeId, false, async (session) => {
        const native = session.parked ?? {
          configuration: await session.connection!.requestControl({ subtype: 'get_settings' }),
          agents: session.connection!.initialization.agents,
          permissionMode: session.connection!.initialization.current_permission_mode,
        };
        return toClaudeConfiguration(
          native.configuration,
          native.agents,
          native.permissionMode,
          nativeId,
          session.settings,
          command,
        );
      });
    },
    /**
     * Names only the native session selected by the admitted action, reopening a parked one.
     * @returns Native acknowledgement of the name change.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async nameThread(requestId: string, nativeId: string, name: string): Promise<void> {
      await withSession(nativeId, true, (session) =>
        session.connection!.requestControl(
          { subtype: 'rename_session', title: name, source: 'host', session_id: nativeId },
          requestId,
        ),
      );
    },
    validateInput,
    /**
     * Writes idle input once and waits for its matching native echo or result.
     * @returns The native user-message identity after acknowledgement.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
     * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async startTurn(
      requestId: string,
      nativeId: string,
      text: string,
      settings: ITurnSettings = {},
      signal?: AbortSignal,
      files: IProviderInputFile[] = [],
    ): Promise<{ id: string }> {
      validateInput(nativeId, settings);
      const isEnvelope =
        settings.outputSchema !== undefined &&
        isEqual(settings.outputSchema, DISPATCH_OUTPUT_SCHEMA);
      return withSession(
        nativeId,
        true,
        async (opened) => {
          let session = opened;
          if (signal?.aborted) unavailable();
          if (session.input) conflict();
          if (isEnvelope && !isEqual(session.settings.outputSchema, DISPATCH_OUTPUT_SCHEMA)) {
            if (
              session.requests.size ||
              [...extensionRequests.values()].some((request) => request.nativeId === nativeId)
            )
              conflict();
            cancelIdleStop(session);
            const selected = { ...session.settings, outputSchema: DISPATCH_OUTPUT_SCHEMA };
            const workspaceRoot = session.workspaceRoot;
            const hasInput = session.hasInput;
            session.isClosing = true;
            await session.connection!.close();
            await session.agentBridge?.release();
            sessions.delete(nativeId);
            await open(nativeId, workspaceRoot, hasInput, undefined, selected, signal);
            session = get(nativeId);
          }
          if (settings.model || settings.effort) {
            await session.connection!.requestControl({
              subtype: 'apply_flag_settings',
              settings: {
                ...(settings.model ? { model: settings.model } : {}),
                ...(settings.effort ? { effortLevel: settings.effort } : {}),
              },
            });
            if (settings.model) session.settings.model = settings.model;
            if (settings.effort) session.settings.effort = settings.effort;
          }
          if (signal?.aborted || session.isClosing || !session.connection?.isAvailable)
            unavailable();
          if (session.input) conflict();
          return new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(
              () =>
                reject(
                  new Exception(
                    'The Claude integration failed: input acknowledgement deadline exceeded',
                    { code: 'JG_AGENT_HQ_CLAUDE_FAILED', data: { kind: 'agent-unavailable' } },
                  ),
                ),
              30_000,
            );
            session.input = {
              id,
              requestId,
              isAcknowledged: false,
              interruptRequested: false,
              hasInterruptionMarker: false,
              finalText: null,
              isOutputOversized: false,
              isOrdinaryEnvelope:
                settings.outputSchema === undefined &&
                isEqual(session.settings.outputSchema, DISPATCH_OUTPUT_SCHEMA),
              resolve,
              reject,
              timer,
            };
            session.hasInput = true;
            cancelIdleStop(session);
            void session
              .connection!.write({
                type: 'user',
                uuid: id,
                session_id: nativeId,
                message: {
                  role: 'user',
                  content: files.length
                    ? [
                        { type: 'text', text },
                        ...files.map((file) =>
                          file.mediaType === 'text/plain'
                            ? {
                                type: 'document',
                                source: {
                                  type: 'text',
                                  media_type: 'text/plain',
                                  data: new TextDecoder('utf-8', { fatal: true }).decode(
                                    file.content,
                                  ),
                                },
                                title: file.path,
                              }
                            : {
                                type: file.mediaType.startsWith('image/') ? 'image' : 'document',
                                source: {
                                  type: 'base64',
                                  media_type: file.mediaType,
                                  data: Buffer.from(file.content).toString('base64'),
                                },
                              },
                        ),
                      ]
                    : text,
                },
                parent_tool_use_id: null,
              })
              .catch(reject);
          });
        },
        signal,
        // a parked session reopens with the envelope a collaboration request needs
        (kept) => (isEnvelope ? { ...kept, outputSchema: DISPATCH_OUTPUT_SCHEMA } : kept),
      );
    },
    /**
     * Requests interruption of the exact active input; completion arrives separately.
     * @returns Acknowledgement of the native interruption request.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async interrupt(requestId: string, nativeId: string, turnId: string): Promise<void> {
      // a parked session is idle, so its interrupt is refused as any idle session's is
      await withSession(nativeId, false, async (session) => {
        if (session.input?.id !== turnId) conflict();
        session.input.interruptRequested = true;
        await session.connection!.requestControl({ subtype: 'interrupt' }, requestId);
      });
    },
    /**
     * Closes the owned CLI and proves that its process group has stopped.
     * @returns Confirmed shutdown including owned background processes.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async stopSession(_requestId: string, nativeId: string): Promise<void> {
      const session = sessions.get(nativeId);
      if (!session) conflict();
      cancelIdleStop(session);
      session.isClosing = true;
      // a parked session finishes without a process
      await session.transition?.catch(() => undefined);
      await session.opening.catch((cause: unknown) => {
        if (
          isException(cause) &&
          z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success
        )
          throw cause;
      });
      await session.connection?.close();
      await session.agentBridge?.release();
    },
    /**
     * Releases a stopped session only after rechecking its shutdown promise.
     * @returns Confirmed release of this session controller.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async releaseSession(_requestId: string, nativeId: string): Promise<void> {
      const session = sessions.get(nativeId);
      if (!session?.isClosing) conflict();
      await session.connection?.close();
      await session.agentBridge?.release();
      sessions.delete(nativeId);
    },
    /**
     * Stops every owned controller, retaining failures instead of claiming cleanup.
     * @returns Confirmed shutdown of all owned native process groups.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async close(): Promise<void> {
      isClosing = true;
      const results = await Promise.allSettled(
        [...sessions.values()].map(async (session) => {
          cancelIdleStop(session);
          session.isClosing = true;
          if (session.input) {
            clearTimeout(session.input.timer);
            session.input.reject(
              new Exception('The Claude integration failed', {
                code: 'JG_AGENT_HQ_CLAUDE_FAILED',
                data: {
                  kind: 'agent-unavailable',
                },
              }),
            );
          }
          await session.opening.catch((cause: unknown) => {
            if (
              isException(cause) &&
              z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success
            )
              throw cause;
          });
          await session.transition?.catch(() => undefined);
          await session.connection?.close();
          await session.agentBridge?.release();
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      sessions.clear();
    },
  };
};
