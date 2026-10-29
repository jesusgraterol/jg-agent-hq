import type { IHqRequest, ISessionTerminal } from '../contracts/index.js';

// what the latest `claude agents --json` run reported about each Claude session it listed
export type IClaudeSessions = {
  workspaceOf(nativeId: string): string | undefined;
  terminalOf(nativeId: string): ISessionTerminal | null;
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
