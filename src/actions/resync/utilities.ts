import type { IProviderReattachment } from '../../providers/index.js';
import type { ITurnRecord } from '../../store/control/index.js';

import type { IResyncDecision, IResyncRequest } from './types.js';
import { RESYNC_LOSS_ORDER } from './constants.js';

/**
 * Merges a re-check into one already waiting for the same session, keeping the most demanding lost
 * kind. A fresh request turns a pending last attempt back into a full re-check.
 * @returns The single request that stands for both.
 */
export const mergeResync = (
  current: IResyncRequest | undefined,
  next: IResyncRequest,
): IResyncRequest => {
  if (!current) return next;
  const isLastAttempt = current.isLastAttempt && next.isLastAttempt;
  return {
    lost:
      RESYNC_LOSS_ORDER.indexOf(next.lost) > RESYNC_LOSS_ORDER.indexOf(current.lost)
        ? next.lost
        : current.lost,
    isLastAttempt,
    turnId: isLastAttempt ? current.turnId : null,
  };
};

/**
 * Decides what a lost notification means for a session, from the turns it recorded and the latest
 * turn its native process reports. A finished turn completes; a running one continues unless its
 * end was lost; an ambiguous one is read once more; an idle, unchanged session is left alone; and
 * anything else, such as a newer turn, a lost approval resolution or a last attempt that still
 * can't settle, makes the session uncertain.
 * @returns The decision the re-check applies.
 */
export const decideResync = (
  record: ITurnRecord,
  latest: IProviderReattachment['latestTurn'],
  request: IResyncRequest,
): IResyncDecision => {
  const active = record.activeTurnId;
  // the turn a last attempt reads again has been settled by other evidence meanwhile
  if (request.isLastAttempt && active !== request.turnId) return { kind: 'none' };
  const isActiveLatest = active !== null && latest !== null && latest.nativeId === active;
  if (isActiveLatest && latest.state !== 'running' && !latest.isInferred)
    return { kind: 'complete', nativeTurnId: active, state: latest.state };
  if (request.isLastAttempt) return { kind: 'uncertain' };
  if (
    isActiveLatest &&
    latest.state === 'running' &&
    (request.lost === 'turn-started' || request.lost === 'unknown')
  )
    return { kind: 'gap' };
  if (
    isActiveLatest &&
    ((latest.state === 'running' && request.lost === 'turn-completed') ||
      (latest.isInferred === true && latest.state === 'interrupted'))
  )
    return { kind: 'reread', nativeTurnId: active };
  if (
    active === null &&
    (latest?.nativeId ?? null) === record.lastTurnId &&
    latest?.state !== 'running'
  )
    return { kind: 'none' };
  return { kind: 'uncertain' };
};
