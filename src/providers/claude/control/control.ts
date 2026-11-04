import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';
import { delay, isEqual } from 'jg-utilities';
import { z } from 'zod';

import type {
  IConfigurationRequest,
  ISessionSettings,
  ITurnSettings,
} from '../../../contracts/index.js';
import type { IProviderInputFile } from '../../inputs/index.js';
import { capabilityUnavailable } from '../../registry/index.js';
import { toClaudeConfiguration } from '../configuration/index.js';

import { createClaudeRpc } from '../rpc.js';
import { HQ_ERRORS, isCleanupUnconfirmed } from '../../../errors/index.js';

import type { IClaudeControlEvents, IClaudeSession } from './types.js';
import {
  failSteers,
  getActiveTurn,
  receiveClaudeMessage,
  setBackgroundCommands,
} from './stream.js';
import { toClaudeSkills } from './skills.js';

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
      !(session.connection?.isAvailable || (isParkedAllowed && session.parked))
    )
      unavailable();
    return session;
  };
  const countOpen = (): number =>
    [...sessions.values()].filter((session) => !session.parked).length;
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
    if (isClosing || session.isClosing) return;
    const idleStop = new AbortController();
    session.idleStop = idleStop;
    void delay(IDLE_STOP_SECONDS, { signal: idleStop.signal }).then(
      () => park(session),
      () => undefined,
    );
  };
  // whether a call, a request or a background command still uses an idle session's process
  const isHeld = (session: IClaudeSession): boolean =>
    activeCalls.has(session.id) || session.requests.size > 0 || session.backgroundTaskCount > 0;
  /**
   * Reads an idle session's native settings once, then closes its process. The session stays idle
   * and records nothing; a call that arrives first keeps the process, and a background command
   * still running holds the session for another idle period, since closing would end it. Both are
   * checked again once the read answers, along with a turn that started meanwhile.
   */
  const park = async (session: IClaudeSession): Promise<void> => {
    const connection = session.connection;
    if (
      isClosing ||
      session.isClosing ||
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
        scheduleIdleStop(session);
        return;
      }
      // a turn that started meanwhile schedules the next idle period once it ends
      if (isClosing || session.isClosing || isBusy(session)) return;
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
        events?.unavailable(session.id);
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
    session.opening = start(session, session.hasInput, signal);
    try {
      await session.opening;
    } catch (error) {
      events?.unavailable(session.id);
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
      return await call(get(nativeId, !isProcessNeeded));
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
    session.isResumed = isResume;
    // a new process has no turn of its own and no background commands yet
    session.nativeTurn = undefined;
    setBackgroundCommands(session, 0, events);
    const connection = await createClaudeRpc(
      (reason) => {
        if (reason !== 'unavailable' || session.isClosing || session.parked) return;
        failSteers(session);
        // the commands stopped with the process
        setBackgroundCommands(session, 0, events);
        if (session.input) {
          clearTimeout(session.input.timer);
          session.input.reject(
            HQ_ERRORS.create('claudeFailed', {
              data: { kind: 'agent-unavailable' },
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
        receive: (raw) => {
          const wasBusy = isBusy(session);
          receiveClaudeMessage(session, raw, events);
          // a turn Claude starts holds the idle period back, and the end of the last turn starts it
          if (!wasBusy && isBusy(session)) cancelIdleStop(session);
          else if (wasBusy && !isBusy(session)) scheduleIdleStop(session);
        },
        lateResponse(id, _result, error) {
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
      await withSession(nativeId, true, (session) =>
        session.connection!.requestControl(
          { subtype: 'rename_session', title: name, source: 'host', session_id: nativeId },
          requestId,
        ),
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
      _requestId: string,
      nativeId: string,
      turnId: string,
      text: string,
    ): Promise<string> {
      // a parked session is idle, so it has no turn to steer
      return withSession(nativeId, false, (session) => {
        if (getActiveTurn(session)?.id !== turnId) conflict();
        if (session.isClosing || !session.connection?.isAvailable) unavailable();
        return new Promise<string>((resolve, reject) => {
          const id = randomUUID();
          session.steers.set(id, { id, turnId, resolve, reject });
          void session
            .connection!.write({
              type: 'user',
              uuid: id,
              session_id: nativeId,
              message: { role: 'user', content: text },
              parent_tool_use_id: null,
            })
            .catch((error: unknown) => {
              session.steers.delete(id);
              reject(error);
            });
        });
      });
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
      await withSession(nativeId, false, async (session) => {
        const turn = session.nativeTurn ?? session.input;
        if (turn?.id !== turnId) conflict();
        turn.interruptRequested = true;
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
      // a stopped process replays nothing more, and its background commands stop with it
      failSteers(session);
      setBackgroundCommands(session, 0, events);
      // a parked session finishes without a process
      await session.transition?.catch(() => undefined);
      await session.opening.catch((cause: unknown) => {
        if (isCleanupUnconfirmed(cause)) throw cause;
      });
      await session.connection?.close();
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
