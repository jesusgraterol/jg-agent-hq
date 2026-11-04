import type { INativeLineage, IProviderId, ISessionState } from '../../contracts/index.js';

// what the provider's first read of a session another client drives found, which its record keeps
export type IObservedThread = { workspaceRoot: string; name: string | null; createdAt: number };

// one observed session's state; Claude's poll reports no first read, since it names the workspace
export type IObservedSession = {
  nativeId: string;
  state: ISessionState;
  thread?: IObservedThread;
};

/*
 * One running or waiting session as the store knows it, or an idle one that runs background
 * commands. A managed session carries its thread, an observed Codex session what the first read
 * of it found, and an observed Claude session its history index entry when its transcript is
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
