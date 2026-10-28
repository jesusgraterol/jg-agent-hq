import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay } from 'jg-utilities';

import type { IObservationPace, ISessionState } from '../../../contracts/index.js';
import { isOwnedProcess } from '../../process.js';
import { resolveWorkspaceTarget } from '../../../runtime/state/index.js';

import {
  AGENTS_BACKGROUND_SECONDS,
  AGENTS_DEADLINE_MS,
  AGENTS_LIVE_SECONDS,
  AGENTS_OUTPUT_BYTES,
} from './constants.js';
import { ClaudeAgentsSchema, type IClaudeAgent } from './types.js';

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
 * sessions inside the allowed workspaces, so a session missing from a run is closed. A failed,
 * late, oversized or malformed run changes nothing. Runs follow one another at the `background`
 * pace until `setPace` selects another, which takes effect with an immediate run.
 * @returns A handle that sets the pace, reports each listed session's `cwd` from the latest run,
 * and whose close stops polling and waits for a run in progress.
 */
export const observeClaudeAgents = (
  record: (sessions: { nativeId: string; state: ISessionState }[]) => Promise<void>,
  allowedRoots: string[],
): {
  setPace(pace: IObservationPace): void;
  workspaceOf(nativeId: string): string | undefined;
  close(): Promise<void>;
} => {
  const lifetime = new AbortController();
  // whether each session directory is inside an allowed workspace, checked once per directory
  const allowedDirectories = new Map<string, boolean>();
  // the cwd of each session the latest run listed, which no other source reports
  let workspaces = new Map<string, string>();
  let pace = 'background' as IObservationPace;
  let wait = new AbortController();
  const isAllowed = async (directory: string): Promise<boolean> => {
    let isInside = allowedDirectories.get(directory);
    if (isInside === undefined) {
      isInside = await resolveWorkspaceTarget(directory, allowedRoots)
        .then(() => true)
        .catch(() => false);
      if (allowedDirectories.size >= 1024)
        allowedDirectories.delete(allowedDirectories.keys().next().value!);
      allowedDirectories.set(directory, isInside);
    }
    return isInside;
  };
  const poll = async (): Promise<void> => {
    let agents: IClaudeAgent[];
    try {
      const { stdout } = await run('claude', ['agents', '--json'], {
        timeout: AGENTS_DEADLINE_MS,
        maxBuffer: AGENTS_OUTPUT_BYTES,
        signal: lifetime.signal,
      });
      agents = ClaudeAgentsSchema.parse(JSON.parse(stdout));
    } catch {
      return;
    }
    const sessions: { nativeId: string; state: ISessionState }[] = [];
    const listed = new Map<string, string>();
    /*
     * An entry without a PID isn't running, whatever its state says, so it counts as missing; the
     * processes this runtime started, managed sessions and the metadata process, are its own.
     */
    for (const agent of agents)
      if (agent.pid !== undefined && !isOwnedProcess(agent.pid) && (await isAllowed(agent.cwd))) {
        sessions.push({ nativeId: agent.sessionId, state: toAgentState(agent) });
        listed.set(agent.sessionId, agent.cwd);
      }
    if (lifetime.signal.aborted) return;
    workspaces = listed;
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
    workspaceOf: (nativeId) => workspaces.get(nativeId),
    async close(): Promise<void> {
      lifetime.abort();
      await running;
    },
  };
};
