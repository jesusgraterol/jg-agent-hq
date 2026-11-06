import type { IManagedThread } from '../contracts/index.js';
import { HQ_ERRORS } from '../errors/index.js';
import type { IProviderReattachment } from '../providers/index.js';

/**
 * Refuses an action whose recorded state doesn't allow it.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const conflict: () => never = () => {
  throw HQ_ERRORS.create('actionConflict', {
    data: { kind: 'state-conflict' },
  });
};

/**
 * Refuses native work while its provider can't do it.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const agentUnavailable: () => never = () => {
  throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' } });
};

/**
 * Refuses unknown execution state before restoring native control.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const assertKnownTurn = (read: IProviderReattachment): void => {
  if (
    read.thread.nativeState === 'systemError' ||
    read.thread.nativeState === 'unknown' ||
    (read.thread.nativeState === 'active' && read.latestTurn?.state !== 'running') ||
    (read.thread.nativeState === 'idle' && read.latestTurn?.state === 'running')
  )
    agentUnavailable();
};

// Codex runs sessions in its shared daemon, which keeps them running when the runtime stops
export const keepsSessions = (provider: IManagedThread['provider']): boolean =>
  provider === 'codex';
