import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { delay } from 'jg-utilities';
import { z } from 'zod';

import type { IObservationPace, ISessionState } from '../../../contracts/index.js';
import { isOwnedProcess } from '../../process.js';
import type { IControlObservation } from '../../index.js';
import { resolveWorkspaceTarget } from '../../../runtime/state/index.js';
import type { IObservedSession } from '../../../store/sessions/index.js';
import { createClaudeBackgroundTasks, READ_BUDGET_BYTES } from '../background/index.js';
import { projectDirectory } from '../history/index.js';

import {
  AGENTS_BACKGROUND_SECONDS,
  AGENTS_DEADLINE_MS,
  AGENTS_LIVE_SECONDS,
  AGENTS_OUTPUT_BYTES,
} from './constants.js';
import {
  ClaudeAgentsSchema,
  type IClaudeAgent,
  type IClaudeAgentsObserver,
  type IListedSession,
  type IClaudeOwnedObserver,
} from './types.js';

const run = promisify(execFile);

/**
 * Maps a running session's report to the shared session state. A session waiting on a question or
 * a permission prompt reports `status: "waiting"`, as an interactive one may also report
 * `blocked`; a background session at work reports `state: "working"` and no status.
 */
export const toAgentState = (agent: IClaudeAgent): ISessionState =>
  agent.status === 'busy' || agent.state === 'working'
    ? 'running'
    : agent.status === 'waiting' || agent.status === 'blocked'
      ? 'waiting'
      : agent.status === 'idle'
        ? 'idle'
        : 'unknown';

/**
 * Polls `claude agents --json` while the runtime runs and records the complete list of active
 * sessions inside the allowed workspaces, each with its resolved `cwd` as its folder, so a session
 * missing from a run is closed. A failed, late, oversized or malformed run changes nothing. Runs
 * follow one another at the `background` pace until `setPace` selects another, which takes effect
 * with an immediate run.
 *
 * Before it records their states, each run counts every listed session's background tasks from
 * its transcript, read since its Claude process started, within one byte budget for the whole run.
 * A transcript is looked for in the Claude project directory of the session's `cwd`, then in that
 * of the workspace `locateTranscript` resolves for its indexed transcript.
 * @param record Records the states of the sessions a run listed.
 * @param allowedRoots The workspaces whose sessions are observed.
 * @param locateTranscript Resolves to the workspace root of a session's indexed transcript, or null.
 * @param owned Captures live controller revisions before the shared inventory and receives its evidence.
 * @returns A handle that sets the pace, reports each listed session's `cwd`, the terminal that runs
 * it and its background tasks from the latest run, reads a session's tasks again on request, and
 * whose close stops polling and waits for a run in progress.
 */
export const observeClaudeAgents = (
  record: (sessions: IObservedSession[]) => Promise<void>,
  allowedRoots: string[],
  locateTranscript: (nativeId: string) => Promise<string | null>,
  owned?: IClaudeOwnedObserver,
): IClaudeAgentsObserver => {
  const lifetime = new AbortController();
  // each session directory resolved inside an allowed workspace, or null outside them, once each
  const allowedDirectories = new Map<string, string | null>();
  // what the latest run listed about each session, which no other source reports
  let listedSessions = new Map<string, IListedSession>();
  const background = createClaudeBackgroundTasks();
  let pace = 'background' as IObservationPace;
  let wait = new AbortController();
  const resolveAllowed = async (directory: string): Promise<string | null> => {
    let resolved = allowedDirectories.get(directory);
    if (resolved === undefined) {
      resolved = await resolveWorkspaceTarget(directory, allowedRoots).catch(() => null);
      if (allowedDirectories.size >= 1024)
        allowedDirectories.delete(allowedDirectories.keys().next().value!);
      allowedDirectories.set(directory, resolved);
    }
    return resolved;
  };
  // the Claude project directory that holds a session's transcript, or null when none does
  const findDirectory = async (nativeId: string, cwd: string): Promise<string | null> => {
    if (!z.uuid().safeParse(nativeId).success) return null;
    try {
      const directory = projectDirectory(cwd);
      await access(join(directory, `${nativeId}.jsonl`));
      return directory;
    } catch {
      // the session may have started in another folder, whose project directory holds it
    }
    try {
      const root = await locateTranscript(nativeId);
      return root === null ? null : projectDirectory(root);
    } catch {
      return null;
    }
  };
  const poll = async (): Promise<void> => {
    const captured = owned?.begin() ?? [];
    let agents: IClaudeAgent[];
    try {
      const { stdout } = await run('claude', ['agents', '--json'], {
        timeout: AGENTS_DEADLINE_MS,
        maxBuffer: AGENTS_OUTPUT_BYTES,
        signal: lifetime.signal,
      });
      agents = ClaudeAgentsSchema.parse(JSON.parse(stdout));
    } catch {
      owned?.complete(captured, null);
      return;
    }
    const sessions: IObservedSession[] = [];
    const listed = new Map<string, IListedSession>();
    const observations: IControlObservation[] = [];
    /*
     * An entry without a PID isn't running, whatever its state says, so it counts as missing; the
     * processes this runtime started, managed sessions and the metadata process, are its own.
     */
    for (const agent of agents) {
      if (agent.pid === undefined) continue;
      const isOwned = isOwnedProcess(agent.pid);
      if (isOwned && !owned) continue;
      const workspaceRoot = await resolveAllowed(agent.cwd);
      if (workspaceRoot !== null) {
        if (owned)
          observations.push({
            nativeId: agent.sessionId,
            workspaceRoot,
            pid: agent.pid,
            state: toAgentState(agent),
            startedAt: agent.startedAt ?? null,
          });
        if (isOwned) continue;
        sessions.push({ nativeId: agent.sessionId, state: toAgentState(agent), workspaceRoot });
        listed.set(agent.sessionId, {
          cwd: agent.cwd,
          terminal:
            agent.kind === 'background' && agent.id
              ? { kind: 'background', attachId: agent.id }
              : { kind: 'interactive' },
          startedAt: agent.startedAt ?? null,
          directory: null,
          backgroundCommands: 0,
        });
      }
    }
    // counts are current before the states they explain are recorded
    const budget = { remaining: READ_BUDGET_BYTES };
    for (const [nativeId, session] of listed) {
      if (lifetime.signal.aborted) return;
      session.directory = await findDirectory(nativeId, session.cwd);
      if (session.directory !== null)
        session.backgroundCommands = await background.update(
          nativeId,
          session.directory,
          session.startedAt,
          budget,
        );
    }
    if (lifetime.signal.aborted) return;
    for (const nativeId of listedSessions.keys())
      if (!listed.has(nativeId)) background.forget(nativeId);
    listedSessions = listed;
    owned?.complete(captured, observations);
    await record(sessions);
  };
  const running = (async () => {
    while (!lifetime.signal.aborted) {
      await poll().catch(() => undefined);
      wait = new AbortController();
      await delay(pace === 'live' ? AGENTS_LIVE_SECONDS : AGENTS_BACKGROUND_SECONDS, {
        signal: AbortSignal.any([lifetime.signal, wait.signal]),
      }).catch(() => undefined);
    }
  })();
  return {
    setPace(next: IObservationPace): void {
      if (next === pace) return;
      pace = next;
      wait.abort();
    },
    workspaceOf: (nativeId) => listedSessions.get(nativeId)?.cwd,
    terminalOf: (nativeId) => listedSessions.get(nativeId)?.terminal ?? null,
    backgroundCommandsOf: (nativeId) => listedSessions.get(nativeId)?.backgroundCommands ?? 0,
    async refreshBackgroundCommands(nativeId: string): Promise<number> {
      const session = listedSessions.get(nativeId);
      if (!session) return 0;
      session.directory ??= await findDirectory(nativeId, session.cwd);
      if (session.directory === null) return 0;
      session.backgroundCommands = await background.update(
        nativeId,
        session.directory,
        session.startedAt,
        { remaining: READ_BUDGET_BYTES },
      );
      // a poll that stopped listing the session while this read ran forgot it before the read ended
      if (!listedSessions.has(nativeId)) {
        background.forget(nativeId);
        return 0;
      }
      return session.backgroundCommands;
    },
    backgroundSessionIds: () =>
      [...listedSessions].flatMap(([nativeId, session]) =>
        session.backgroundCommands > 0 ? [nativeId] : [],
      ),
    async close(): Promise<void> {
      lifetime.abort();
      await running;
    },
  };
};
