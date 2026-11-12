import { z } from 'zod';

import type { IObservationPace, ISessionTerminal } from '../../../contracts/index.js';
import type { IControlObservation, IControlSnapshot } from '../../index.js';

// one shared inventory brackets owned activity without introducing session-specific polls
export type IClaudeOwnedObserver = {
  begin(): IControlSnapshot[];
  complete(snapshots: IControlSnapshot[], observations: IControlObservation[] | null): void;
};

// one active session; interactive entries report a status and background entries a state
export const ClaudeAgentSchema = z.object({
  // the short ID `claude attach` takes, which only background sessions report
  id: z.string().min(1).max(64).optional(),
  kind: z.string().max(64).optional(),
  sessionId: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  // present only while the session's process runs
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  status: z.string().max(64).optional(),
  state: z.string().max(64).optional(),
  // when the session's Claude process started, in Unix milliseconds
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type IClaudeAgent = z.infer<typeof ClaudeAgentSchema>;
export const ClaudeAgentsSchema = z.array(ClaudeAgentSchema).max(1024);

// what the latest run reported about one session, with the background tasks its transcript records
export type IListedSession = {
  cwd: string;
  terminal: ISessionTerminal;
  startedAt: number | null;
  // the Claude project directory that holds its transcript, once found
  directory: string | null;
  backgroundCommands: number;
};

// the running poll, with what its latest run listed
export type IClaudeAgentsObserver = {
  setPace(pace: IObservationPace): void;
  workspaceOf(nativeId: string): string | undefined;
  terminalOf(nativeId: string): ISessionTerminal | null;
  backgroundCommandsOf(nativeId: string): number;
  refreshBackgroundCommands(nativeId: string): Promise<number>;
  backgroundSessionIds(): string[];
  close(): Promise<void>;
};
