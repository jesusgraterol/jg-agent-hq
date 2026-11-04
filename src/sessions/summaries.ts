import type {
  IManagedThread,
  IProviderId,
  ISessionState,
  IThreadSummary,
} from '../contracts/index.js';
import { retainNativeLineage } from '../providers/index.js';
import type { IStore } from '../store/index.js';

import type { IClaudeSessions } from './types.js';

/**
 * Adds the terminal that runs a session and its background commands, which only Claude reports.
 * @returns The summary with both.
 */
export const withListing = (summary: IThreadSummary, claude: IClaudeSessions): IThreadSummary => ({
  ...summary,
  terminal: summary.provider === 'claude' ? claude.terminalOf(summary.nativeId) : null,
  backgroundCommands:
    summary.provider === 'claude' ? claude.backgroundCommandsOf(summary.nativeId) : 0,
});

/**
 * Summarizes managed threads as `threads` does, each in the state its record maps to.
 * @returns One summary per thread, in order.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const toManagedSummaries = async (
  projection: IStore,
  threads: IManagedThread[],
): Promise<IThreadSummary[]> => {
  const states = new Map<string, ISessionState>();
  for (const provider of new Set(threads.map((thread) => thread.provider)))
    for (const session of await projection.call(
      'sessions',
      'states',
      provider,
      threads.flatMap((thread) =>
        thread.provider === provider && thread.nativeId ? [thread.nativeId] : [],
      ),
    ))
      states.set(JSON.stringify([provider, session.nativeId]), session.state);
  return threads.map((thread) => ({
    provider: thread.provider,
    nativeId: thread.nativeId!,
    nativeLineage: thread.nativeLineage,
    workspaceRoot: thread.workspaceRoot,
    name: thread.name,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    nativeState: 'unknown',
    state: states.get(JSON.stringify([thread.provider, thread.nativeId])) ?? 'unknown',
    ownership: thread.ownership,
    managedId: thread.id,
    historyState: 'available',
    terminal: null,
    backgroundCommands: 0,
    continuedIn: null,
  }));
};

/**
 * Joins one provider's native summaries with HQ's records: a managed session's name, ownership,
 * HQ ID and lineage, every session's recorded live state, and the listing Claude reports.
 * @param projection The store.
 * @param claude What the latest `claude agents --json` run reported.
 * @param provider The provider every summary belongs to.
 * @param threads The summaries, changed in place.
 * @returns A promise that resolves once every summary is joined.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const joinRecords = async (
  projection: IStore,
  claude: IClaudeSessions,
  provider: IProviderId,
  threads: IThreadSummary[],
): Promise<void> => {
  if (!threads.length) return;
  const nativeIds = threads.map((thread) => thread.nativeId);
  const managed = new Map(
    (await projection.call('reads', 'getNativeThreads', provider, nativeIds)).map((thread) => [
      thread.nativeId,
      thread,
    ]),
  );
  const states = new Map(
    (await projection.call('sessions', 'states', provider, nativeIds)).map((session) => [
      session.nativeId,
      session.state,
    ]),
  );
  for (const thread of threads) {
    const control = managed.get(thread.nativeId);
    if (control) {
      thread.ownership = control.ownership;
      thread.managedId = control.id;
      thread.name = control.name;
      thread.nativeLineage = retainNativeLineage(control.nativeLineage, thread.nativeLineage);
    }
    thread.state = states.get(thread.nativeId) ?? thread.state;
    Object.assign(thread, withListing(thread, claude));
  }
};
