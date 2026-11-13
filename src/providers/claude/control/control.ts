import { randomUUID } from 'node:crypto';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, isException } from 'jg-exception';
import { delay, isEqual } from 'jg-utilities';
import { z } from 'zod';

import { ActionEnvelopeSchema } from '../../../contracts/index.js';
import type {
  IConfigurationRequest,
  ISessionSettings,
  ITurnSettings,
} from '../../../contracts/index.js';
import type { IProviderInputFile } from '../../inputs/index.js';
import type { IControlObservation, IControlSnapshot, IControlSource } from '../../index.js';
import { parseActionRequest } from '../../utilities.js';
import { capabilityUnavailable } from '../../registry/index.js';
import { toClaudeConfiguration } from '../configuration/index.js';

import { createClaudeRpc } from '../rpc.js';
import { HQ_ERRORS, isCleanupUnconfirmed } from '../../../errors/index.js';

import { CLAUDE_STEER_MEDIA_TYPES } from './constants.js';
import type { IClaudeControlEvents, IClaudeSavedInput, IClaudeSession } from './types.js';
import {
  failSteers,
  getActiveTurn,
  receiveClaudeMessage,
  setBackgroundCommands,
} from './stream.js';
import { toClaudeSkills } from './skills.js';
import { createClaudeQuarantineMonitor } from './quarantine.js';

/** Keeps turn-start document encoding and uses labeled text for mid-turn text files. */
const toFileBlocks = (files: IProviderInputFile[], isSteer = false) =>
  files.map((file) => {
    if (file.mediaType === 'text/plain') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
      return isSteer
        ? { type: 'text', text: `File ${file.path} (SHA-256 ${file.sha256}):\n${text}` }
        : {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: text },
            title: file.path,
          };
    }
    return {
      type: file.mediaType.startsWith('image/') ? 'image' : 'document',
      source: {
        type: 'base64',
        media_type: file.mediaType,
        data: Buffer.from(file.content).toString('base64'),
      },
    };
  });

// a session idle this long since its last turn ended gives up its process until it is needed
const IDLE_STOP_SECONDS = 3_600;

/**
 * Owns one persistent native CLI per explicitly controlled Claude session.
 * @returns Controls whose processes outlive client connections and stop at runtime shutdown.
 */
export const createClaudeControl = (additionalDirectories: string[] = []) => {
  const sessions = new Map<string, IClaudeSession>();
  // calls running against each session, which a session never parks during
  const activeCalls = new Map<string, number>();
  let events: IClaudeControlEvents | undefined;
  let isClosing = false;
  const unavailable: () => never = () => {
    throw HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } });
  };
  const conflict: () => never = () => {
    throw HQ_ERRORS.create('actionConflict', {
      data: { kind: 'state-conflict' },
    });
  };
  const get = (id: string, isParkedAllowed = false): IClaudeSession => {
    const session = sessions.get(id);
    if (
      !session ||
      session.isClosing ||
      session.isQuarantined ||
      !(session.connection?.isAvailable || (isParkedAllowed && session.parked))
    )
      unavailable();
    return session;
  };
  const countOpen = (): number =>
    [...sessions.values()].filter((session) => !session.parked).length;
  /** Binds native callbacks to the controller generation, independently of frame payload IDs. */
  const eventsFor = (session: IClaudeSession, scope = session.scope): IClaudeControlEvents => {
    const source = { nativeId: session.id, workspaceRoot: session.workspaceRoot, scope };
    return {
      observe: (observation) => events?.observe(observation, source),
      item: (nativeId, item, complete, replacedIds) =>
        events?.item(nativeId, item, complete, replacedIds, source),
      gap: (nativeId) => events?.gap(nativeId, source),
      background: (nativeId, count) => events?.background(nativeId, count, source),
      delta: (nativeId, turnId, itemId, text) =>
        events?.delta(nativeId, turnId, itemId, text, source),
      prompt: (prompt) => events?.prompt(prompt, source),
      outcome: (outcome, thread) => events?.outcome(outcome, thread, source),
      unavailable: (nativeId, controlScope) => events?.unavailable(nativeId, controlScope, source),
    };
  };
  /** Suspends HQ interpretation while leaving the owned native process and its work running. */
  const quarantineSession = (session: IClaudeSession, scope: string, cause?: unknown): boolean => {
    if (sessions.get(session.id) !== session || session.scope !== scope || session.parked)
      return false;
    if (session.isQuarantined) return true;
    if (session.isClosing) {
      // its existing close owns shutdown and settlement; late evidence must not escalate to peers
      session.connection?.quarantine(cause);
      return true;
    }
    session.isQuarantined = true;
    session.quiescentRevision = undefined;
    cancelIdleStop(session);
    const failure = new Exception(
      `The Claude integration failed${cause === undefined ? '' : `: ${extractMessage(cause)}`}`,
      { code: 'JG_AGENT_HQ_CLAUDE_FAILED', data: { kind: 'agent-unavailable' }, cause },
    );
    failSteers(session, undefined, failure);
    if (session.input) {
      clearTimeout(session.input.timer);
      session.input.reject(failure);
    }
    session.connection?.quarantine(cause);
    events?.quarantined?.({ nativeId: session.id, workspaceRoot: session.workspaceRoot, scope });
    return true;
  };
  /** Stops the wait that parks an idle session, as a turn or a stop does. */
  const cancelIdleStop = (session: IClaudeSession): void => {
    session.idleStop?.abort();
    session.idleStop = undefined;
  };
  // a session is busy while HQ input waits or runs, or while a turn Claude started runs
  const isBusy = (session: IClaudeSession): boolean =>
    session.input !== undefined || session.nativeTurn !== undefined;
  /** Parks the session once it stays idle for the whole period, restarting any earlier wait. */
  const scheduleIdleStop = (session: IClaudeSession): void => {
    cancelIdleStop(session);
    if (
      isClosing ||
      session.isClosing ||
      session.isQuarantined ||
      sessions.get(session.id) !== session
    )
      return;
    const scope = session.scope;
    const idleStop = new AbortController();
    session.idleStop = idleStop;
    void delay(IDLE_STOP_SECONDS, { signal: idleStop.signal }).then(
      () => park(session, scope),
      () => undefined,
    );
  };
  // whether a call, a request or a background command still uses an idle session's process
  const isHeld = (session: IClaudeSession): boolean =>
    activeCalls.has(session.id) || session.requests.size > 0 || session.backgroundTaskCount > 0;
  /** Rechecks positive lifecycle proof at the owned close boundary, never using rich turn state. */
  const canStopQuarantined = (session: IClaudeSession): boolean =>
    !isClosing &&
    !session.isClosing &&
    session.isQuarantined === true &&
    sessions.get(session.id) === session &&
    session.connection?.isAvailable === true &&
    session.quiescentRevision !== undefined &&
    session.monitor?.canStop(session.quiescentRevision) === true &&
    !session.connection.hasPendingRequests &&
    !activeCalls.has(session.id);
  /**
   * Reads an idle session's native settings once, then closes its process. The session stays idle
   * and records nothing; a call that arrives first keeps the process, and a background command
   * still running holds the session for another idle period, since closing would end it. Both are
   * checked again once the read answers, along with a turn that started meanwhile.
   */
  const park = async (session: IClaudeSession, expectedScope: string): Promise<void> => {
    const connection = session.connection;
    if (
      isClosing ||
      session.isClosing ||
      session.isQuarantined ||
      sessions.get(session.id) !== session ||
      session.scope !== expectedScope ||
      isBusy(session) ||
      session.transition ||
      !connection?.isAvailable
    )
      return;
    if (isHeld(session)) {
      scheduleIdleStop(session);
      return;
    }
    session.transition = (async () => {
      let configuration: unknown;
      try {
        configuration = await connection.requestControl({ subtype: 'get_settings' });
      } catch {
        if (session.scope === expectedScope) scheduleIdleStop(session);
        return;
      }
      // a turn that started meanwhile schedules the next idle period once it ends
      if (
        isClosing ||
        session.isClosing ||
        session.isQuarantined ||
        isBusy(session) ||
        sessions.get(session.id) !== session ||
        session.scope !== expectedScope ||
        session.connection !== connection
      )
        return;
      if (isHeld(session)) {
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
        session.connection = undefined;
      } catch {
        session.parked = undefined;
        eventsFor(session, expectedScope).unavailable(session.id, expectedScope);
      }
    })().finally(() => {
      session.transition = undefined;
    });
    await session.transition;
  };
  /**
   * Reopens a parked session with `--resume` and its kept settings; a session that fails to reopen
   * is unavailable, as one whose process was lost.
   */
  const reopen = async (session: IClaudeSession, signal?: AbortSignal): Promise<void> => {
    if (isClosing || countOpen() >= 32) conflict();
    session.parked = undefined;
    session.scope = randomUUID();
    session.replayedSteers?.clear();
    const scope = session.scope;
    session.opening = start(session, session.hasInput, signal);
    try {
      await session.opening;
    } catch (error) {
      eventsFor(session, scope).unavailable(session.id, scope);
      throw error;
    }
  };
  /**
   * Runs one call on a session after any park or reopen in progress, never letting it park
   * meanwhile. A parked session reopens first when the call needs its process, and otherwise
   * answers from what it kept.
   */
  const withSession = async <T>(
    nativeId: string,
    isProcessNeeded: boolean,
    call: (session: IClaudeSession) => Promise<T>,
    signal?: AbortSignal,
    isControl = false,
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
        parked.transition = reopen(parked, signal).finally(() => {
          parked.transition = undefined;
        });
        await parked.transition;
      }
      const current = get(nativeId, !isProcessNeeded);
      const scope = current.scope;
      try {
        const result = await call(current);
        if (isControl && current.isQuarantined) unavailable();
        return result;
      } catch (cause) {
        if (
          isControl &&
          (cause instanceof z.ZodError || (isException(cause) && cause.cause instanceof z.ZodError))
        )
          quarantineSession(current, scope, cause);
        throw cause;
      }
    } finally {
      const count = (activeCalls.get(nativeId) ?? 1) - 1;
      if (count > 0) activeCalls.set(nativeId, count);
      else activeCalls.delete(nativeId);
    }
  };
  /**
   * Requires a turn's output format to be the one its session started with.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   */
  const validateInput = (nativeId: string, settings: ITurnSettings): void => {
    if (
      settings.outputSchema &&
      !isEqual(settings.outputSchema, get(nativeId, true).settings.outputSchema)
    )
      capabilityUnavailable();
  };
  /**
   * Starts a session's native process and permits control only after native idle initialization,
   * beginning its idle period.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const start = async (
    session: IClaudeSession,
    isResume: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const nativeId = session.id;
    const scope = session.scope;
    const nativeEvents = eventsFor(session, scope);
    const monitor = createClaudeQuarantineMonitor();
    session.monitor = monitor;
    session.quiescentRevision = undefined;
    session.nativeStartedAt = undefined;
    session.isResumed = isResume;
    // a new process has no turn of its own and no background commands yet
    session.nativeTurn = undefined;
    setBackgroundCommands(session, 0, nativeEvents);
    const connection = await createClaudeRpc(
      (reason) => {
        if (
          reason !== 'unavailable' ||
          session.isClosing ||
          session.parked ||
          sessions.get(nativeId) !== session ||
          session.scope !== scope
        )
          return;
        failSteers(session);
        if (session.input) {
          clearTimeout(session.input.timer);
          session.input.reject(
            HQ_ERRORS.create('claudeFailed', {
              data: { kind: 'agent-unavailable' },
            }),
          );
        }
        nativeEvents.unavailable(session.id, scope);
      },
      {
        nativeId,
        workspaceRoot: session.workspaceRoot,
        additionalDirectories,
        isResume,
        settings: session.settings,
        quarantine: (cause) => quarantineSession(session, scope, cause),
        observe(raw) {
          if (sessions.get(nativeId) !== session || session.scope !== scope) return;
          monitor.observe(raw);
          session.quiescentRevision = undefined;
          if (session.isQuarantined)
            setBackgroundCommands(session, monitor.backgroundCount, nativeEvents);
        },
        written(raw) {
          if (sessions.get(nativeId) !== session || session.scope !== scope) return;
          monitor.written(raw);
          session.quiescentRevision = undefined;
        },
        receive: (raw) => {
          if (
            session.isQuarantined ||
            sessions.get(nativeId) !== session ||
            session.scope !== scope
          )
            return;
          const wasBusy = isBusy(session);
          receiveClaudeMessage(session, raw, nativeEvents);
          // a turn Claude starts holds the idle period back, and the end of the last turn starts it
          if (!wasBusy && isBusy(session)) cancelIdleStop(session);
          else if (wasBusy && !isBusy(session)) scheduleIdleStop(session);
        },
        lateResponse(id, _result, error) {
          if (
            session.isQuarantined ||
            sessions.get(nativeId) !== session ||
            session.scope !== scope
          )
            return;
          // only a name or an interrupt is a control request an action phase sends
          const request = parseActionRequest(id);
          if (request?.phase !== 'name' && request?.phase !== 'interrupt') return;
          if (error !== undefined)
            nativeEvents.outcome({ kind: 'failed', ...request, failure: 'agent-unavailable' });
          else
            nativeEvents.outcome({
              kind: request.phase === 'name' ? 'renamed' : 'interrupt-accepted',
              ...request,
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
  };
  /**
   * Records ownership before startup and permits control only after native idle initialization.
   * Parked sessions don't count toward the 32 open processes.
   * @returns The process-bound native identity and workspace.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const open = async (
    nativeId: string,
    workspaceRoot: string,
    isResume: boolean,
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
      hasInput: isResume,
      isResumed: false,
      backgroundTaskCount: 0,
      opening: Promise.resolve(),
      previews: new Map(),
      requests: new Map(),
      steers: new Map(),
    };
    sessions.set(nativeId, session);
    session.opening = start(session, isResume, signal);
    await session.opening;
    if (session.isQuarantined) unavailable();
    return { id: nativeId, cwd: workspaceRoot, status: { type: 'idle' as const } };
  };
  return {
    get isAvailable() {
      return !isClosing;
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
    /** Settles pending native waits from exact saved input without starting another turn. */
    confirmSavedSteers(nativeId: string, workspaceRoot: string, items: IClaudeSavedInput[]): void {
      const session = sessions.get(nativeId);
      if (!session || session.isQuarantined || session.workspaceRoot !== workspaceRoot) return;
      for (const item of items) {
        const inputId = item.provenance.nativeInputId;
        const steer = inputId === null ? undefined : session.steers.get(inputId);
        const turnId = 'reference' in item ? item.reference.turnId : item.turnId;
        if (
          !steer ||
          steer.isAcknowledged ||
          item.kind !== 'user-message' ||
          item.provenance.nativeInputSha256 !== steer.inputSha256 ||
          (turnId !== steer.turnId && turnId !== steer.id)
        )
          continue;
        // a later live replay still needs its exact identity to start its own native turn
        steer.isAcknowledged = true;
        steer.resolve(steer.turnId);
        eventsFor(session).outcome({
          kind: 'steer-accepted',
          actionId: steer.id,
          phase: 'steer',
          nativeTurnId: steer.turnId,
        });
      }
    },
    /**
     * Starts an idle native session with normal local instructions and settings.
     * @returns The exact native session identity and workspace.
     * @throws
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
      return open(randomUUID(), workspaceRoot, false, settings, signal);
    },
    /**
     * Loads a confirmed handoff and verifies its native session identity.
     * @returns The native idle state after the session-id fence succeeds.
     * @throws
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
      const result = await open(nativeId, workspaceRoot, true, settings, signal);
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
          session.isResumed,
          session.fastMode,
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
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async nameThread(requestId: string, nativeId: string, name: string): Promise<void> {
      await withSession(
        nativeId,
        true,
        (session) =>
          session.connection!.requestControl(
            { subtype: 'rename_session', title: name, source: 'host', session_id: nativeId },
            requestId,
          ),
        undefined,
        true,
      );
    },
    validateInput,
    /**
     * Writes input once and waits for its matching native echo or result. Input written while a
     * turn Claude started runs is replayed only after that turn's result, so a long turn can
     * outlast the wait, and the late replay reconciles it.
     * @returns The native user-message identity after acknowledgement.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
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
      return withSession(
        nativeId,
        true,
        async (session) => {
          if (signal?.aborted) unavailable();
          if (session.input) conflict();
          if (settings.model || settings.effort || settings.fast !== undefined) {
            await session.connection!.requestControl({
              subtype: 'apply_flag_settings',
              settings: {
                ...(settings.model ? { model: settings.model } : {}),
                ...(settings.effort ? { effortLevel: settings.effort } : {}),
                ...(settings.fast !== undefined ? { fastMode: settings.fast } : {}),
              },
            });
            // a parked session reopens with what was applied, so it keeps these choices
            if (settings.model) session.settings.model = settings.model;
            if (settings.effort) session.settings.effort = settings.effort;
            if (settings.fast !== undefined) session.settings.fast = settings.fast;
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
                  content: files.length ? [{ type: 'text', text }, ...toFileBlocks(files)] : text,
                },
                parent_tool_use_id: null,
              })
              .catch(reject);
          });
        },
        signal,
        true,
      );
    },
    /**
     * Writes text into the exact active turn, HQ input's or one Claude started, without
     * interrupting it. Claude takes it in at the turn's next tool boundary and replays it there,
     * or, for text written while the turn's final answer streams, replays it after the turn's
     * result and runs it as the session's next turn. Either replay acknowledges the steer against
     * the turn it named; a stopped process, or no replay within 30 seconds of that turn's end,
     * fails it.
     * @returns The turn the steer named, once Claude replayed it.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async steer(
      requestId: string,
      nativeId: string,
      turnId: string,
      text: string,
      files: IProviderInputFile[] = [],
    ): Promise<string> {
      const parsedId = ActionEnvelopeSchema.shape.id.safeParse(
        requestId.endsWith(':steer') ? requestId.slice(0, -':steer'.length) : null,
      );
      if (!parsedId.success) conflict();
      if (files.some((file) => !CLAUDE_STEER_MEDIA_TYPES.includes(file.mediaType)))
        capabilityUnavailable();
      // a parked session is idle, so it has no turn to steer
      return withSession(
        nativeId,
        false,
        (session) => {
          if (getActiveTurn(session)?.id !== turnId) conflict();
          if (session.isClosing || !session.connection?.isAvailable) unavailable();
          return new Promise<string>((resolve, reject) => {
            const id = parsedId.data;
            session.steers.set(id, {
              id,
              turnId,
              inputSha256: hashValue(text),
              isAcknowledged: false,
              resolve,
              reject,
            });
            void session
              .connection!.write({
                type: 'user',
                uuid: id,
                session_id: nativeId,
                message: {
                  role: 'user',
                  content: files.length
                    ? [{ type: 'text', text }, ...toFileBlocks(files, true)]
                    : text,
                },
                parent_tool_use_id: null,
              })
              .catch((error: unknown) => {
                session.steers.delete(id);
                reject(error);
              });
          });
        },
        undefined,
        true,
      );
    },
    /**
     * Requests interruption of the exact active turn, HQ input's or one Claude started; completion
     * arrives separately.
     * @returns Acknowledgement of the native interruption request.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async interrupt(requestId: string, nativeId: string, turnId: string): Promise<void> {
      // a parked session is idle, so its interrupt is refused as any idle session's is
      await withSession(
        nativeId,
        false,
        async (session) => {
          const turn = session.nativeTurn ?? session.input;
          if (turn?.id !== turnId) conflict();
          turn.interruptRequested = true;
          await session.connection!.requestControl({ subtype: 'interrupt' }, requestId);
        },
        undefined,
        true,
      );
    },
    /**
     * Reads the owned identity without opening or changing its process.
     * @returns Current controller identity, or undefined for a missing or replaced scope.
     */
    getControlIdentity(
      nativeId: string,
      expectedScope?: string,
    ):
      | { scope: string; workspaceRoot: string; isClosing: boolean; releaseActionId?: string }
      | undefined {
      const session = sessions.get(nativeId);
      if (!session || (expectedScope !== undefined && session.scope !== expectedScope)) return;
      return {
        scope: session.scope,
        workspaceRoot: session.workspaceRoot,
        isClosing: session.isClosing,
        ...(session.releaseActionId ? { releaseActionId: session.releaseActionId } : {}),
      };
    },
    /** @returns Current process-bound identity without trusting native frame identifiers. */
    getControlSource(nativeId: string): IControlSource | undefined {
      const session = sessions.get(nativeId);
      return session && { nativeId, workspaceRoot: session.workspaceRoot, scope: session.scope };
    },
    /** @returns Whether the exact retained controller suspended interpretation. */
    isControlQuarantined(source: IControlSource): boolean {
      const session = sessions.get(source.nativeId);
      return (
        !!session &&
        session.scope === source.scope &&
        session.workspaceRoot === source.workspaceRoot &&
        session.isQuarantined === true
      );
    },
    /** @returns Whether the exact current controller contained the evidence failure. */
    quarantineControl(source: IControlSource, cause?: unknown): boolean {
      const session = sessions.get(source.nativeId);
      return (
        !!session &&
        session.workspaceRoot === source.workspaceRoot &&
        quarantineSession(session, source.scope, cause)
      );
    },
    /** @returns Live owned handles and activity revisions captured before the shared native poll. */
    snapshotControls(): IControlSnapshot[] {
      const snapshots: IControlSnapshot[] = [];
      for (const session of sessions.values()) {
        const connection = session.connection;
        if (
          !connection?.isAvailable ||
          connection.pid === undefined ||
          !session.monitor ||
          session.isClosing ||
          session.parked
        )
          continue;
        snapshots.push({
          nativeId: session.id,
          workspaceRoot: session.workspaceRoot,
          scope: session.scope,
          pid: connection.pid,
          revision: session.monitor.revision,
        });
      }
      return snapshots;
    },
    /** Applies only exact owned inventory identities; missing or changed evidence clears idle proof. */
    observeControls(
      snapshots: IControlSnapshot[],
      observations: IControlObservation[] | null,
    ): void {
      const byPid = new Map<number, IControlObservation | null>();
      const byNativeId = new Map<string, IControlObservation | null>();
      for (const observation of observations ?? []) {
        byPid.set(observation.pid, byPid.has(observation.pid) ? null : observation);
        byNativeId.set(
          observation.nativeId,
          byNativeId.has(observation.nativeId) ? null : observation,
        );
      }
      for (const snapshot of snapshots) {
        const session = sessions.get(snapshot.nativeId);
        if (
          !session ||
          session.scope !== snapshot.scope ||
          session.workspaceRoot !== snapshot.workspaceRoot
        )
          continue;
        session.quiescentRevision = undefined;
        const observation = byPid.get(snapshot.pid);
        if (
          !observation ||
          byNativeId.get(snapshot.nativeId) !== observation ||
          observation.nativeId !== session.id ||
          observation.workspaceRoot !== session.workspaceRoot ||
          session.connection?.pid !== snapshot.pid ||
          !session.connection.isAvailable
        )
          continue;
        if (
          session.nativeStartedAt !== undefined &&
          observation.startedAt !== session.nativeStartedAt
        )
          continue;
        if (observation.startedAt !== null) session.nativeStartedAt = observation.startedAt;
        if (
          !session.isQuarantined ||
          observation.state !== 'idle' ||
          !session.monitor?.canStop(snapshot.revision) ||
          session.connection.hasPendingRequests ||
          activeCalls.has(session.id)
        )
          continue;
        session.quiescentRevision = snapshot.revision;
        events?.quiescent?.({
          nativeId: session.id,
          workspaceRoot: session.workspaceRoot,
          scope: session.scope,
        });
      }
    },
    /**
     * Closes the owned CLI and proves that its process group has stopped.
     * An admitted close reserves release before awaiting any automatic shutdown already running.
     * @param requestId The exact cleanup request, retained when its action owns release.
     * @param nativeId The controlled native conversation.
     * @param expectedScope The controller generation to stop, when supplied.
     * @param requiresQuiescence Whether fresh independent idle proof is required before closing.
     * @param ownsRelease Whether an admitted close owns the later controller release.
     * @returns Confirmed shutdown including owned background processes.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async stopSession(
      requestId: string,
      nativeId: string,
      expectedScope?: string,
      requiresQuiescence = false,
      ownsRelease = false,
    ): Promise<void> {
      const session = sessions.get(nativeId);
      if (!session || (expectedScope !== undefined && session.scope !== expectedScope)) conflict();
      if (ownsRelease) session.releaseActionId = requestId;
      cancelIdleStop(session);
      if (requiresQuiescence && !canStopQuarantined(session)) conflict();
      if (!requiresQuiescence) session.isClosing = true;
      // a closing controller accepts no more steers, but its group is not proven stopped yet
      failSteers(session);
      // a parked session finishes without a process
      await session.transition?.catch(() => undefined);
      await session.opening.catch((cause: unknown) => {
        if (isCleanupUnconfirmed(cause)) throw cause;
      });
      if (requiresQuiescence) {
        if (
          sessions.get(nativeId) !== session ||
          (expectedScope !== undefined && session.scope !== expectedScope) ||
          !canStopQuarantined(session)
        )
          conflict();
        session.isClosing = true;
      }
      await session.connection?.close();
      setBackgroundCommands(session, 0, eventsFor(session));
    },
    /**
     * Releases a stopped session only after rechecking its shutdown promise.
     * @returns Confirmed release of this session controller.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async releaseSession(
      _requestId: string,
      nativeId: string,
      expectedScope?: string,
    ): Promise<void> {
      const session = sessions.get(nativeId);
      if (!session?.isClosing || (expectedScope !== undefined && session.scope !== expectedScope))
        conflict();
      await session.connection?.close();
      if (sessions.get(nativeId) !== session) conflict();
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
          failSteers(session);
          if (session.input) {
            clearTimeout(session.input.timer);
            session.input.reject(
              HQ_ERRORS.create('claudeFailed', {
                data: { kind: 'agent-unavailable' },
              }),
            );
          }
          await session.opening.catch((cause: unknown) => {
            if (isCleanupUnconfirmed(cause)) throw cause;
          });
          await session.transition?.catch(() => undefined);
          await session.connection?.close();
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      sessions.clear();
    },
  };
};
