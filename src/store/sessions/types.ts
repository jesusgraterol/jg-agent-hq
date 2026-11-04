import type { INativeLineage, IProviderId, ISessionState } from '../../contracts/index.js';

/*
 * One running or waiting session as the store knows it, or an idle one that runs background
 * commands. A managed session carries its thread,
 * and an observed Claude session its history index entry when its transcript is indexed; an
 * observed session's workspace is resolved outside the store.
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
  history: {
    name: string | null;
    createdAt: number;
    updatedAt: number;
    isSupported: boolean;
  } | null;
};
