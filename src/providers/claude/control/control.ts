import { randomUUID } from 'node:crypto';
import { Exception, isException } from 'jg-exception';
import { z } from 'zod';

import { createClaudeRpc } from '../rpc.js';

import type { IClaudeControlEvents, IClaudeSession } from './types.js';
import { receiveClaudeMessage } from './stream.js';
import { toClaudeSkills } from './skills.js';

/**
 * Owns one persistent native CLI per explicitly controlled Claude session.
 * @returns Controls whose processes outlive client connections and stop at runtime shutdown.
 */
export const createClaudeControl = (additionalDirectories: string[] = []) => {
  const sessions = new Map<string, IClaudeSession>();
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
  const get = (id: string): IClaudeSession => {
    const session = sessions.get(id);
    if (!session?.connection?.isAvailable || session.isClosing) unavailable();
    return session;
  };
  /**
   * Records ownership before startup and permits control only after native idle initialization.
   * @returns The process-bound native identity and workspace.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const open = async (nativeId: string, workspaceRoot: string, isResume: boolean) => {
    if (
      isClosing ||
      sessions.has(nativeId) ||
      sessions.size >= 32 ||
      !z.uuid().safeParse(nativeId).success
    )
      conflict();
    const session: IClaudeSession = {
      id: nativeId,
      workspaceRoot,
      scope: randomUUID(),
      isClosing: false,
      opening: Promise.resolve(),
      previews: new Map(),
      requests: new Map(),
    };
    sessions.set(nativeId, session);
    session.opening = (async () => {
      const connection = await createClaudeRpc(
        (reason) => {
          if (reason !== 'unavailable' || session.isClosing) return;
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
          workspaceRoot,
          additionalDirectories,
          isResume,
          receive: (raw) => receiveClaudeMessage(session, raw, events),
          lateResponse(id, result, error) {
            if (!/^[a-f0-9-]{36}:(name|interrupt)$/.test(id)) return;
            const actionId = id.slice(0, 36);
            if (error !== undefined)
              events?.outcome({
                kind: 'failed',
                actionId,
                requestId: id,
                failure: 'agent-unavailable',
              });
            else
              events?.outcome({
                kind: id.endsWith(':name') ? 'renamed' : 'interrupt-accepted',
                actionId,
                requestId: id,
              });
          },
        },
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
    })();
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
          : sessions.size
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
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async startThread(_requestId: string, workspaceRoot: string) {
      return open(randomUUID(), workspaceRoot, false);
    },
    /**
     * Loads a confirmed handoff and verifies its native session identity.
     * @returns The native idle state after the session-id fence succeeds.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async resumeThread(_requestId: string, nativeId: string, workspaceRoot: string, name: string) {
      const result = await open(nativeId, workspaceRoot, true);
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
      const skills = get(nativeId).skills;
      if (!skills) unavailable();
      return skills;
    },
    /**
     * Names only the native session selected by the admitted action.
     * @returns Native acknowledgement of the name change.
     * @throws
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async nameThread(requestId: string, nativeId: string, name: string): Promise<void> {
      await get(nativeId).connection!.requestControl(
        { subtype: 'rename_session', title: name, source: 'host', session_id: nativeId },
        requestId,
      );
    },
    /**
     * Writes idle input once and waits for its matching native echo or result.
     * @returns The native user-message identity after acknowledgement.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async startTurn(requestId: string, nativeId: string, text: string): Promise<{ id: string }> {
      const session = get(nativeId);
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
          resolve,
          reject,
          timer,
        };
        void session
          .connection!.write({
            type: 'user',
            uuid: id,
            session_id: nativeId,
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
          })
          .catch(reject);
      });
    },
    /**
     * Requests interruption of the exact active input; completion arrives separately.
     * @returns Acknowledgement of the native interruption request.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async interrupt(requestId: string, nativeId: string, turnId: string): Promise<void> {
      const session = get(nativeId);
      if (session.input?.id !== turnId) conflict();
      session.input.interruptRequested = true;
      await session.connection!.requestControl({ subtype: 'interrupt' }, requestId);
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
      session.isClosing = true;
      await session.opening.catch((cause: unknown) => {
        if (
          isException(cause) &&
          z.object({ cleanupUnconfirmed: z.literal(true) }).safeParse(cause.data).success
        )
          throw cause;
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
          await session.connection?.close();
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      sessions.clear();
    },
  };
};
