import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ISessionState } from '../../../contracts/index.js';
import { resolveWorkspaceTarget } from '../../../runtime/state/index.js';

import { AGENTS_DEADLINE_MS, AGENTS_OUTPUT_BYTES, AGENTS_POLL_INTERVAL_MS } from './constants.js';
import { ClaudeAgentsSchema, type IClaudeAgent } from './types.js';

const run = promisify(execFile);

/**
 * Maps a native report to the shared session state: an interactive session reports `waiting` on a
 * question or permission prompt, and a background one `blocked`.
 */
export const toAgentState = (agent: IClaudeAgent): ISessionState => {
  const reported = agent.status ?? agent.state;
  return reported === 'busy'
    ? 'running'
    : reported === 'waiting' || reported === 'blocked'
      ? 'waiting'
      : reported === 'idle'
        ? 'idle'
        : 'unknown';
};

/**
 * Polls `claude agents --json` while the runtime runs and records the complete list of active
 * sessions inside the allowed workspaces, so a session missing from a run is closed. A failed,
 * late, oversized or malformed run changes nothing.
 * @returns A handle whose close stops polling and waits for a run in progress.
 */
export const observeClaudeAgents = (
  record: (sessions: { nativeId: string; state: ISessionState }[]) => Promise<void>,
  allowedRoots: string[],
): { close(): Promise<void> } => {
  const lifetime = new AbortController();
  // whether each session directory is inside an allowed workspace, checked once per directory
  const allowedDirectories = new Map<string, boolean>();
  let running: Promise<void> | undefined;
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
    for (const agent of agents)
      if (await isAllowed(agent.cwd))
        sessions.push({ nativeId: agent.sessionId, state: toAgentState(agent) });
    if (!lifetime.signal.aborted) await record(sessions);
  };
  const start = (): void => {
    if (running || lifetime.signal.aborted) return;
    running = poll()
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(start, AGENTS_POLL_INTERVAL_MS);
  timer.unref();
  start();
  return {
    async close(): Promise<void> {
      clearInterval(timer);
      lifetime.abort();
      await running;
    },
  };
};
