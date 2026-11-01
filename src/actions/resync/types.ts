import type { IProviderReattachment, IResyncLoss } from '../../providers/index.js';

// a re-check waiting or running for one controlled session
export type IResyncRequest = {
  lost: IResyncLoss;
  // the delayed read of one turn whose saved state was ambiguous, which can't be delayed again
  isLastAttempt: boolean;
  // the turn a last attempt reads again
  turnId: string | null;
};

// what a re-check concludes from the turns a session recorded and the latest one its process reports
export type IResyncDecision =
  | {
      kind: 'complete';
      nativeTurnId: string;
      state: Exclude<NonNullable<IProviderReattachment['latestTurn']>['state'], 'running'>;
    }
  | { kind: 'gap' }
  | { kind: 'reread'; nativeTurnId: string }
  | { kind: 'none' }
  | { kind: 'uncertain' };
