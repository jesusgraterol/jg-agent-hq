import type { IHqRequest } from '../contracts/index.js';

// reads with explicit native identities or a scoped discovery target
export type IHistoryRequest = Extract<
  IHqRequest,
  { kind: 'threads' | 'thread' | 'turns' | 'items' | 'session-evidence' }
>;
