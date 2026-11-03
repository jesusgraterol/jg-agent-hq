import type { IHqRequest, ISessionTerminal } from '../contracts/index.js';

// what the latest `claude agents --json` run reported about each Claude session it listed
export type IClaudeSessions = {
  workspaceOf(nativeId: string): string | undefined;
  terminalOf(nativeId: string): ISessionTerminal | null;
  // the background tasks a Claude session runs, from its live window or its transcript
  backgroundCommandsOf(nativeId: string): number;
  // the same, with its transcript read again first
  refreshBackgroundCommands(nativeId: string): Promise<number>;
  // the sessions, of any provider, that run background tasks
  backgroundSessions(): { provider: string; nativeId: string }[];
};

// reads with explicit native identities or a scoped discovery target
export type IHistoryRequest = Extract<
  IHqRequest,
  {
    kind:
      | 'threads'
      | 'thread'
      | 'turns'
      | 'items'
      | 'item-detail'
      | 'item-image'
      | 'session-evidence';
  }
>;
