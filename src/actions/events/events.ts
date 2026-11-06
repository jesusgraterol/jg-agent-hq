import { randomUUID } from 'node:crypto';
import { signHmac } from 'jg-crypto';
import { isException } from 'jg-exception';
import { delay } from 'jg-utilities';

import { MAX_ITEM_TEXT_LENGTH, MAX_PAGE_SIZE, type IManagedThread } from '../../contracts/index.js';
import { HQ_ERRORS, getErrorKind } from '../../errors/index.js';
import type { IProviderReattachment } from '../../providers/index.js';
import { capabilityUnavailable } from '../../providers/registry/index.js';
import type { INativeObservation } from '../../store/control/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';

import type { createDispatch } from '../dispatch/index.js';
import {
  RESYNC_REREAD_DELAY_SECONDS,
  Resyncs,
  decideResync,
  type IResyncRequest,
} from '../resync/index.js';
import type { IActionsContext } from '../types.js';
import { agentUnavailable, keepsSessions } from '../utilities.js';

import { TURN_FLUSH_PAGES } from './constants.js';

/**
 * Receives native evidence from the providers and persists it in order, one bounded lane per
 * provider, re-checking sessions whose evidence was lost.
 * @returns The event operations dispatch and reattachment share.
 */
export const createEvents = (
  context: IActionsContext,
  dispatcher: ReturnType<typeof createDispatch>,
) => {
  const { registry, store, epoch, actionKey, runBackground, state, prompts, controlled, live } =
    context;
  const { watched, waits, resyncLifetime, key, own, runOwned } = context;
  const { verifyThread, advanceQueue, apply, dispatch } = dispatcher;
  const eventCounts = new Map<IManagedThread['provider'], number>();
  // providers whose connection reports the sessions other clients drive
  const observingProviders = new Set<IManagedThread['provider']>();

  /**
   * Records native evidence, then wakes the receipt waits it can affect: a lost connection's on
   * every receipt, and other evidence's on its thread's receipts.
   * @returns The refreshed thread and whether its queue may advance.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const recordObservation = async (observation: INativeObservation) => {
    const result = await store.call('observations', 'observe', observation);
    if (observation.kind === 'native-unavailable') waits.notifyAll();
    else if (result.thread) waits.notifyThread(result.thread.id);
    return result;
  };

  /** Quarantines controls after a lifecycle gap and stops the native transport. */
  const failEvents = (cause?: unknown): void => {
    if (state.isUnavailable) return;
    state.isUnavailable = true;
    state.eventFailure = cause;
    prompts.clear();
    const previous = state.lane;
    state.lane = runBackground(async () => {
      await previous.catch(() => undefined);
      for (const { provider } of registry.statuses())
        await recordObservation({ kind: 'native-unavailable', provider });
    });
    void state.lane.catch((error: unknown) => {
      state.eventFailure = error;
    });
    void registry.close().catch((error: unknown) => {
      state.eventFailure = error;
    });
  };

  /** Stops one event source after its bounded lane loses lifecycle evidence. */
  const failProvider = (provider: IManagedThread['provider'], cause: unknown): void => {
    if (context.blockedProviders.has(provider)) return;
    context.blockedProviders.add(provider);
    for (const [id, prompt] of prompts) if (prompt.native.provider === provider) prompts.delete(id);
    const previous = state.lane;
    state.lane = runBackground(async () => {
      await previous.catch(() => undefined);
      await recordObservation({ kind: 'native-unavailable', provider });
    });
    void state.lane.catch(failEvents);
    registry.quarantine(provider, cause);
  };

  /** Contains native protocol failures to the affected controller before releasing its transport. */
  const runNativeOwned = (
    provider: IManagedThread['provider'],
    nativeId: string | undefined,
    operation: () => Promise<void>,
  ): void => {
    runOwned(async () => {
      try {
        await operation();
      } catch {
        await recordObservation({
          kind: 'native-unavailable',
          provider,
          ...(nativeId ? { nativeThreadId: nativeId } : {}),
        });
        try {
          await registry.stopControl(provider, nativeId);
        } catch {
          /* the registry retains failed cleanup and quarantines this provider */
        }
      }
    });
  };
  /** Orders lifecycle persistence without buffering an unbounded stream. */
  const enqueue = (provider: IManagedThread['provider'], operation: () => Promise<void>): void => {
    if (state.isUnavailable || context.blockedProviders.has(provider)) return;
    if ((eventCounts.get(provider) ?? 0) >= 128) {
      failProvider(
        provider,
        HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' } }),
      );
      return;
    }
    eventCounts.set(provider, (eventCounts.get(provider) ?? 0) + 1);
    const previous = state.lane;
    state.lane = runBackground(async () => {
      try {
        await previous.catch(() => undefined);
        if (state.isUnavailable) return;
        await operation();
      } finally {
        const pending = (eventCounts.get(provider) ?? 1) - 1;
        if (pending) eventCounts.set(provider, pending);
        else eventCounts.delete(provider);
      }
    });
    void state.lane.catch((error) => {
      if (
        getErrorKind(error) === 'agent-unavailable' ||
        getErrorKind(error) === 'access-denied' ||
        getErrorKind(error) === 'state-conflict' ||
        (isException(error) && error.code === 'JG_AGENT_HQ_TRANSPORT_FAILED')
      )
        failProvider(provider, error);
      else failEvents(error);
    });
  };

  // finished turns whose own history is being read, so a turn is read by one task at a time
  const flushing = new Set<string>();
  /*
   * A saved item leaves the live window only once a native history page holds it, and a client may
   * never read the pages that do, so a finished turn's own history is read here, newest first,
   * until none of its saved items remain. Codex's saved state can trail its turn's end, so a turn
   * whose items remain is read once more after the re-check wait. An aborted wait or a failed read
   * leaves them to the next history read, as before, and never fails the session's events.
   */
  const flushTurn = (
    provider: IManagedThread['provider'],
    nativeId: string,
    workspaceRoot: string,
    turnId: string,
  ): void => {
    const liveKey = key(provider, nativeId);
    const flushKey = JSON.stringify([liveKey, turnId]);
    if (flushing.has(flushKey)) return;
    flushing.add(flushKey);
    runOwned(async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0)
            await delay(RESYNC_REREAD_DELAY_SECONDS, { signal: resyncLifetime.signal });
          const control = await registry.get(provider);
          let cursor: string | undefined;
          for (let page = 0; page < TURN_FLUSH_PAGES; page += 1) {
            if (state.isClosing || !live.awaitsFlush(liveKey, turnId)) return;
            const response = await control.readHistory({
              kind: 'items',
              provider,
              workspaceRoot,
              nativeId,
              turnId,
              limit: MAX_PAGE_SIZE,
              cursor,
              textLimit: MAX_ITEM_TEXT_LENGTH,
            });
            if (response.kind !== 'items') return;
            live.reconcile(liveKey, response.result.data);
            if (response.result.nextCursor === null) break;
            cursor = response.result.nextCursor;
          }
        }
      } catch {
        // the items wait for the next history read
      } finally {
        flushing.delete(flushKey);
      }
    });
  };

  const observe = async (observation: INativeObservation): Promise<void> => {
    const result = await recordObservation(observation);
    if (observation.kind === 'turn-completed') {
      if (result.thread && controlled.has(key(observation.provider, observation.nativeThreadId)))
        flushTurn(
          observation.provider,
          observation.nativeThreadId,
          result.thread.workspaceRoot,
          observation.nativeTurnId,
        );
      watched.delete(key(observation.provider, observation.nativeThreadId));
      for (const [id, prompt] of prompts)
        if (
          prompt.native.provider === observation.provider &&
          prompt.native.nativeThreadId === observation.nativeThreadId &&
          prompt.native.nativeTurnId === observation.nativeTurnId
        )
          prompts.delete(id);
    }
    if (observation.kind === 'request-resolved' || observation.kind === 'request-canceled')
      for (const [id, prompt] of prompts)
        if (
          prompt.native.provider === observation.provider &&
          prompt.native.requestId === observation.requestId &&
          prompt.native.nativeThreadId === observation.nativeThreadId
        )
          prompts.delete(id);
    if (result.canDispatchQueued && result.thread)
      advanceQueue(result.thread.id, result.thread.provider);
    // a close whose interrupted turn ended continues from clean
    const { continued, thread } = result;
    if (continued && thread)
      runOwned(async () => {
        await dispatch(continued, thread);
      });
  };
  /** Orders one observation about a controlled session behind the events before it. */
  const receiveObservation = (
    provider: IManagedThread['provider'],
    observation: INativeObservation,
  ): void => {
    if (
      !('nativeThreadId' in observation) ||
      !observation.nativeThreadId ||
      !controlled.has(key(provider, observation.nativeThreadId))
    )
      return;
    if (observation.kind === 'turn-completed')
      live.completeTurn(key(provider, observation.nativeThreadId), observation.nativeTurnId);
    enqueue(provider, () => observe(observation));
  };

  /**
   * Makes up for a lost notification by reading the session from its native process, outside the
   * shared lane, then orders only the resulting observation behind the events before it. A failed
   * read makes the session uncertain.
   * @returns A promise resolved once the decision is applied or scheduled.
   */
  const recheck = async (
    provider: IManagedThread['provider'],
    nativeId: string,
    request: IResyncRequest,
  ): Promise<void> => {
    if (state.isClosing || !controlled.has(key(provider, nativeId))) return;
    const record = await store.call('reads', 'getTurnRecord', provider, nativeId);
    if (!record) return;
    // an action in flight may have started a turn the record doesn't hold yet
    if (
      (request.lost === 'unknown' || request.lost === 'turn-started') &&
      record.hasPendingAction
    ) {
      watched.add(key(provider, nativeId));
      return;
    }
    let latest: IProviderReattachment['latestTurn'] | undefined;
    try {
      const control = await registry.get(provider);
      if (!control.readReattachment) capabilityUnavailable();
      latest = (await control.readReattachment(nativeId, record.workspaceRoot)).latestTurn;
    } catch {
      latest = undefined;
    }
    const decision =
      latest === undefined
        ? ({ kind: 'uncertain' } as const)
        : decideResync(record, latest, request);
    if (decision.kind === 'complete')
      receiveObservation(provider, {
        kind: 'turn-completed',
        provider,
        nativeThreadId: nativeId,
        nativeTurnId: decision.nativeTurnId,
        state: decision.state,
      });
    else if (decision.kind === 'gap') live.markGap(key(provider, nativeId));
    else if (decision.kind === 'watch') {
      live.markGap(key(provider, nativeId));
      watched.add(key(provider, nativeId));
    } else if (decision.kind === 'reread') {
      const reread = { lost: request.lost, isLastAttempt: true, turnId: decision.nativeTurnId };
      // the wait holds back no other session's re-check
      runOwned(async () => {
        try {
          await delay(RESYNC_REREAD_DELAY_SECONDS, { signal: resyncLifetime.signal });
        } catch {
          return;
        }
        if (!state.isClosing) resyncs.request(provider, nativeId, reread);
      });
    } else if (decision.kind === 'uncertain')
      enqueue(provider, () =>
        observe({ kind: 'native-unavailable', provider, nativeThreadId: nativeId }),
      );
  };
  const resyncs = new Resyncs(recheck, runOwned);

  registry.setEvents({
    observe: receiveObservation,
    resync(provider, nativeId, lost) {
      if (state.isClosing) return;
      const request: IResyncRequest = { lost, isLastAttempt: false, turnId: null };
      // without a session, every session this runtime controls through the provider is read
      if (nativeId === undefined) {
        for (const thread of controlled.values())
          if (thread.provider === provider) resyncs.request(provider, thread.nativeId, request);
      } else if (controlled.has(key(provider, nativeId)))
        resyncs.request(provider, nativeId, request);
    },
    // a live item stays in the window, which keeps one entry per item, and never reaches the store
    item(provider, nativeId, item, isComplete, replacedIds) {
      if (!controlled.has(key(provider, nativeId))) return;
      for (const replacedId of replacedIds ?? [])
        live.replace(key(provider, nativeId), item.turnId, replacedId);
      live.put(key(provider, nativeId), item, isComplete);
    },
    gap(provider, nativeId) {
      if (controlled.has(key(provider, nativeId))) live.markGap(key(provider, nativeId));
    },
    background(provider, nativeId, count) {
      if (controlled.has(key(provider, nativeId)))
        live.setBackgroundCommands(key(provider, nativeId), count);
    },
    session(provider, nativeId, sessionState, thread) {
      observingProviders.add(provider);
      const sessionKey = key(provider, nativeId);
      // a session this runtime controls reports its transitions through its own thread state
      if (controlled.has(sessionKey)) {
        if (watched.has(sessionKey) && sessionState !== 'running' && sessionState !== 'waiting') {
          watched.delete(sessionKey);
          resyncs.request(provider, nativeId, {
            lost: 'turn-completed',
            isLastAttempt: false,
            turnId: null,
          });
        }
        return;
      }
      enqueue(provider, () =>
        store.call(
          'sessions',
          'observe',
          provider,
          [{ nativeId, state: sessionState, thread }],
          false,
        ),
      );
    },
    delta(provider, nativeId, turnId, itemId, text) {
      if (controlled.has(key(provider, nativeId)))
        live.append(key(provider, nativeId), turnId, itemId, text);
    },
    prompt(provider, prompt) {
      // a session that outlives the runtime keeps its request for the next runtime to answer
      if (state.isClosing && keepsSessions(provider)) return;
      // the client driving a session HQ doesn't control answers its requests, so HQ stays silent
      if (!controlled.has(key(provider, prompt.nativeThreadId))) return;
      if (prompts.size >= 32 || state.isClosing) {
        runNativeOwned(provider, prompt.nativeThreadId, prompt.reject);
        return;
      }
      enqueue(provider, async () => {
        const recorded = await store.call('observations', 'openApproval', {
          id: randomUUID(),
          provider,
          nativeThreadId: prompt.nativeThreadId,
          nativeTurnId: prompt.nativeTurnId,
          requestId: prompt.requestId,
          kind: prompt.presentation.kind,
          isBlocking: prompt.presentation.isBlocking,
          digest: signHmac(prompt.fingerprint, actionKey),
        });
        if (!recorded) {
          await prompt.reject();
          return;
        }
        if (prompts.has(recorded.id)) return;
        prompts.set(recorded.id, {
          native: prompt,
          threadId: recorded.thread.id,
        });
      });
    },
    unpresentable(provider, nativeId, reject) {
      if (state.isClosing && keepsSessions(provider)) return;
      // only a session HQ controls waits on HQ for an answer
      if (!controlled.has(key(provider, nativeId))) return;
      runNativeOwned(provider, nativeId, reject);
    },
    outcome(provider, outcome, nativeThread) {
      if (state.isClosing) return;
      enqueue(provider, async () => {
        const receipt = await store.call('reads', 'getAction', outcome.actionId);
        if (
          !receipt ||
          receipt.runtimeEpoch !== epoch ||
          receipt.phase !== outcome.phase ||
          !['submitted', 'uncertain'].includes(receipt.delivery) ||
          receipt.provider !== provider ||
          !receipt.threadId
        )
          return;
        const thread = await store.call('reads', 'getThread', receipt.threadId);
        if (!thread || thread.provider !== provider) return;
        let verifiedOutcome = outcome;
        if (nativeThread && (outcome.kind === 'created' || outcome.kind === 'resumed')) {
          if (outcome.kind === 'resumed' && nativeThread.nativeId !== thread.nativeId)
            agentUnavailable();
          const verified = await verifyThread(thread, nativeThread);
          verifiedOutcome = { ...outcome, nativeLineage: verified.nativeLineage };
          if (outcome.kind === 'created') own(provider, verified.nativeId);
        }
        if (outcome.kind === 'workspace-confirmed') {
          if (
            !nativeThread ||
            nativeThread.nativeId !== thread.nativeId ||
            outcome.workspaceRoot !== receipt.workspaceTransition?.targetWorkspaceRoot ||
            (await resolveWorkspaceTarget(nativeThread.workspaceRoot, context.roots)) !==
              outcome.workspaceRoot
          )
            agentUnavailable();
        }
        const updated = await apply(verifiedOutcome);
        // a late answer that moved its action to its next phase continues it
        if (updated?.delivery === 'submitted' && updated.phase !== outcome.phase)
          runOwned(async () => {
            const current = await store.call('reads', 'getThread', thread.id);
            if (current) await dispatch(updated, current);
          });
      });
    },
    unavailable(provider, nativeId) {
      if (state.isClosing || context.blockedProviders.has(provider)) return;
      enqueue(provider, async () => {
        await recordObservation({
          kind: 'native-unavailable',
          provider,
          ...(nativeId ? { nativeThreadId: nativeId } : {}),
        });
        // only sessions observed through the lost connection lose their known state
        if (!nativeId && observingProviders.has(provider))
          await store.call('sessions', 'markUnknown', provider);
        for (const [id, prompt] of prompts)
          if (
            prompt.native.provider === provider &&
            (!nativeId || prompt.native.nativeThreadId === nativeId)
          )
            prompts.delete(id);
      });
      runNativeOwned(provider, nativeId, async () => registry.stopControl(provider, nativeId));
    },
  });

  return { recordObservation, failEvents, enqueue, observe };
};
