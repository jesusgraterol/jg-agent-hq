import { expect, test } from 'vitest';

import type { IProviderReattachment, IResyncLoss } from '../../providers/index.js';
import type { ITurnRecord } from '../../store/control/index.js';

import { decideResync, mergeResync } from './utilities.js';
import type { IResyncDecision, IResyncRequest } from './types.js';

const running: ITurnRecord = {
  threadId: '00000000-0000-4000-8000-000000000001',
  workspaceRoot: '/workspace',
  activeTurnId: 'turn-1',
  lastTurnId: 'turn-0',
};
const idle: ITurnRecord = { ...running, activeTurnId: null, lastTurnId: 'turn-1' };
const fresh = (lost: IResyncLoss): IResyncRequest => ({ lost, isLastAttempt: false, turnId: null });
const lastAttempt: IResyncRequest = {
  lost: 'turn-completed',
  isLastAttempt: true,
  turnId: 'turn-1',
};
type ITurn = IProviderReattachment['latestTurn'];
const turn = (nativeId: string, state: NonNullable<ITurn>['state'], isInferred = false): ITurn => ({
  nativeId,
  state,
  isInferred,
});

test.each<[string, ITurnRecord, ITurn, IResyncRequest, IResyncDecision]>([
  [
    'a finished active turn completes',
    running,
    turn('turn-1', 'completed'),
    fresh('turn-completed'),
    { kind: 'complete', nativeTurnId: 'turn-1', state: 'completed' },
  ],
  [
    'a finished active turn completes even after a lost approval resolution',
    running,
    turn('turn-1', 'failed'),
    fresh('approval-resolved'),
    { kind: 'complete', nativeTurnId: 'turn-1', state: 'failed' },
  ],
  [
    'a running turn whose start was lost continues',
    running,
    turn('turn-1', 'running', true),
    fresh('turn-started'),
    { kind: 'gap' },
  ],
  [
    'a running turn after an unidentified loss continues',
    running,
    turn('turn-1', 'running', true),
    fresh('unknown'),
    { kind: 'gap' },
  ],
  [
    'a running turn whose end was lost is read again',
    running,
    turn('turn-1', 'running', true),
    fresh('turn-completed'),
    { kind: 'reread', nativeTurnId: 'turn-1' },
  ],
  [
    'an interruption inferred from an idle status is read again',
    running,
    turn('turn-1', 'interrupted', true),
    fresh('turn-started'),
    { kind: 'reread', nativeTurnId: 'turn-1' },
  ],
  [
    'a running turn after a lost approval resolution is uncertain',
    running,
    turn('turn-1', 'running', true),
    fresh('approval-resolved'),
    { kind: 'uncertain' },
  ],
  [
    'a newer turn than the active one is uncertain',
    running,
    turn('turn-2', 'running', true),
    fresh('turn-started'),
    { kind: 'uncertain' },
  ],
  [
    'an idle session whose latest turn is its last one is left alone',
    idle,
    turn('turn-1', 'completed'),
    fresh('approval-resolved'),
    { kind: 'none' },
  ],
  [
    'an idle session with no turns is left alone',
    { ...idle, lastTurnId: null },
    null,
    fresh('unknown'),
    { kind: 'none' },
  ],
  [
    'an idle session another client moved is uncertain',
    idle,
    turn('turn-2', 'completed'),
    fresh('unknown'),
    { kind: 'uncertain' },
  ],
  [
    'an idle session whose latest turn runs is uncertain',
    idle,
    turn('turn-1', 'running', true),
    fresh('turn-started'),
    { kind: 'uncertain' },
  ],
  [
    'a last attempt that finds the turn finished completes it',
    running,
    turn('turn-1', 'completed'),
    lastAttempt,
    { kind: 'complete', nativeTurnId: 'turn-1', state: 'completed' },
  ],
  [
    'a last attempt that still finds the turn running is uncertain',
    running,
    turn('turn-1', 'running', true),
    lastAttempt,
    { kind: 'uncertain' },
  ],
  [
    'a last attempt whose turn other evidence settled meanwhile changes nothing',
    idle,
    turn('turn-1', 'completed'),
    lastAttempt,
    { kind: 'none' },
  ],
])('decideResync(%s)', (_label, record, latest, request, expected) => {
  expect(decideResync(record, latest, request)).toStrictEqual(expected);
});

test('mergeResync keeps the most demanding lost kind and drops a last attempt for a fresh request', () => {
  expect(mergeResync(undefined, fresh('unknown'))).toStrictEqual(fresh('unknown'));
  expect(mergeResync(fresh('approval-resolved'), fresh('turn-started'))).toStrictEqual(
    fresh('approval-resolved'),
  );
  expect(mergeResync(fresh('unknown'), fresh('turn-completed'))).toStrictEqual(
    fresh('turn-completed'),
  );
  expect(mergeResync(lastAttempt, fresh('unknown'))).toStrictEqual(fresh('turn-completed'));
  expect(mergeResync(lastAttempt, lastAttempt)).toStrictEqual(lastAttempt);
});
