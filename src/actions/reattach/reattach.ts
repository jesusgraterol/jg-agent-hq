import { randomUUID } from 'node:crypto';

import type { IManagedThread } from '../../contracts/index.js';
import { capabilityUnavailable } from '../../providers/registry/index.js';

import type { createDispatch } from '../dispatch/index.js';
import type { createEvents } from '../events/index.js';
import type { IActionsContext } from '../types.js';
import { agentUnavailable } from '../utilities.js';

/**
 * Rejoins the sessions the previous runtime left running in a native process that outlives it.
 * @returns The rejoining operation, which the runtime runs once it starts.
 */
export const createReattach = (
  context: IActionsContext,
  dispatcher: ReturnType<typeof createDispatch>,
  events: ReturnType<typeof createEvents>,
) => {
  const { registry, store, epoch, state, live, waits, key, own } = context;
  const { validateRoot, advanceQueue } = dispatcher;
  const { recordObservation, enqueue, observe } = events;

  /**
   * Rejoins one session the previous runtime left running in a native process that outlives it.
   * The session is bound to this runtime as that process reports it before joining, so a request
   * the process sends again on joining finds its turn, and a turn that finished between the two
   * reads then completes. A session that can't be rejoined has its ownership marked uncertain.
   * @returns A promise resolved once the session is rejoined or marked uncertain.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const reattachThread = async (thread: IManagedThread): Promise<void> => {
    const nativeId = thread.nativeId!;
    let isOwned = false;
    try {
      const control = await registry.get(thread.provider);
      if (!control.readReattachment || !control.reattachThread) capabilityUnavailable();
      await validateRoot(thread);
      const read = await control.readReattachment(nativeId, thread.workspaceRoot);
      if (read.thread.nativeState === 'systemError') agentUnavailable();
      const bound = await store.call('lifecycle', 'reattach', {
        threadId: thread.id,
        latestTurn: read.latestTurn && {
          nativeTurnId: read.latestTurn.nativeId,
          state: read.latestTurn.state,
        },
      });
      waits.notifyThread(thread.id);
      if (bound?.thread?.ownership !== 'managed' || bound.thread.runtimeEpoch !== epoch) return;
      own(thread.provider, nativeId);
      isOwned = true;
      const joined = await control.reattachThread(
        `${randomUUID()}:reattach`,
        nativeId,
        thread.workspaceRoot,
      );
      const turnId = bound.thread.activeTurnId;
      const latest = joined.latestTurn;
      if (turnId && latest?.nativeId === turnId && latest.state !== 'running') {
        const { state: turnState } = latest;
        live.completeTurn(key(thread.provider, nativeId), turnId);
        enqueue(thread.provider, () =>
          observe({
            kind: 'turn-completed',
            provider: thread.provider,
            nativeThreadId: nativeId,
            nativeTurnId: turnId,
            state: turnState,
          }),
        );
      }
      if (bound.canDispatchQueued) advanceQueue(thread.id, thread.provider);
    } catch {
      if (isOwned)
        await recordObservation({
          kind: 'native-unavailable',
          provider: thread.provider,
          nativeThreadId: nativeId,
        });
      else await store.call('lifecycle', 'quarantineThread', thread.id);
      waits.notifyThread(thread.id);
    }
  };
  /** Rejoins, one at a time, every session the previous runtime left running. */
  const reattach = async (): Promise<void> => {
    let batch = await store.call('lifecycle', 'listReattachable');
    while (batch.length > 0 && !state.isClosing) {
      for (const thread of batch) if (!state.isClosing) await reattachThread(thread);
      batch = await store.call('lifecycle', 'listReattachable');
    }
  };

  return { reattach };
};
