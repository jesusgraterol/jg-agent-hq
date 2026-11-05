import type { INativeLineage, IProviderId, ISessionState } from '../../contracts/index.js';

// the latest confirmed metadata of a session another client drives, which its record keeps
export type IObservedThread = { workspaceRoot: string; name: string | null; createdAt: number };

/*
 * One observed session's state. Codex's adapter reports its confirmed native metadata, and
 * Claude's poll the folder it lists the session in.
 */
export type IObservedSession = {
  nativeId: string;
  state: ISessionState;
  thread?: IObservedThread;
  workspaceRoot?: string;
};

/*
 * One running or waiting session as the store knows it, or an idle one that runs background
 * commands. A managed session carries its thread, an observed Codex session its latest confirmed
 * metadata, and an observed Claude session its history index entry when its transcript is
 * indexed; an observed Claude session's workspace is resolved outside the store.
 */
export type IActiveSessionRecord = {
  provider: IProviderId;
  nativeId: string;
  state: Extract<ISessionState, 'running' | 'waiting' | 'idle'>;
  changedAt: number;
  thread: {
    id: string;
    ownership: 'managed' | 'uncertain';
    name: string;
    workspaceRoot: string;
    nativeLineage: INativeLineage | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  observed: IObservedThread | null;
  history: {
    name: string | null;
    createdAt: number;
    updatedAt: number;
    isSupported: boolean;
  } | null;
};
