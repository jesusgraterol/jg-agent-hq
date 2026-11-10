import type { IHistoryItem, IProviderId } from '../../contracts/index.js';

// exact controlled source; historical presentation never grants input or approval authority
export type IAsyncInputSource = {
  threadId: string;
  provider: IProviderId;
  nativeId: string;
  workspaceRoot: string;
};
export type IAsyncInputEvent =
  | { kind: 'item'; source: IAsyncInputSource; item: IHistoryItem }
  | {
      kind: 'recovery';
      provider: IProviderId;
      source: IAsyncInputSource | null;
      reason: 'subscribed' | 'reconnect' | 'output-gap' | 'listener-failed';
    };

// listeners synchronously enqueue bounded host work; they must not perform blocking work
export type IAsyncInputListener = (event: IAsyncInputEvent) => void;
