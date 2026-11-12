import { randomUUID } from 'node:crypto';
import { signHmac } from 'jg-crypto';
import { isException } from 'jg-exception';
import { delay } from 'jg-utilities';
import { z } from 'zod';

import {
  MAX_ITEM_TEXT_LENGTH,
  MAX_PAGE_SIZE,
  type IManagedThread,
  type IHistoryItem,
} from '../../contracts/index.js';
import { HQ_ERRORS, getErrorKind } from '../../errors/index.js';
import type {
  IControlSource,
  IProviderReattachment,
  IStoppedControl,
} from '../../providers/index.js';
import { capabilityUnavailable } from '../../providers/registry/index.js';
import type { INativeObservation } from '../../store/control/index.js';
import { correlateEvidenceOrigins } from '../../sessions/index.js';

import type { createDispatch } from '../dispatch/index.js';
import {
  RESYNC_REREAD_DELAY_SECONDS,
  Resyncs,
  decideResync,
  type IResyncRequest,
} from '../resync/index.js';
import type { IActionsContext, IOwnedControl } from '../types.js';
import { agentUnavailable, conflict, keepsSessions } from '../utilities.js';

import { TURN_FLUSH_PAGES } from './constants.js';

/**
 * Receives native evidence from the providers and persists it in order, one bounded lane per
 * provider, re-checking sessions whose evidence was lost.
 * @returns The event operations dispatch and reattachment share.
 */
export const createEvents = (
  context: IActionsContext,
  dispatcher: ReturnType<typeof createDispatch>,
  reconnect: (threads: IManagedThread[]) => Promise<void>,
) => {
  const { registry, store, epoch, actionKey, runBackground, state, prompts, controlled, live } =
    context;
  const { watched, waits, resyncLifetime, key, own, runOwned } = context;
  const { verifyThread, advanceQueue, apply, dispatch } = dispatcher;
  const eventCounts = new Map<IManagedThread['provider'], number>();
  // providers whose connection reports the sessions other clients drive
  const observingProviders = new Set<IManagedThread['provider']>();

  /** Resolves event identity through the controlled record before exposing it to a trusted host. */
  const observeAsyncInput = (
    provider: IManagedThread['provider'],
    nativeId: string,
    item?: IHistoryItem,
    source?: IControlSource,
  ): void => {
    if (state.isClosing || !context.asyncInputs.hasListeners()) return;
    enqueue(
      provider,
      async () => {
        const thread = await store.call('reads', 'getThreadByNativeId', provider, nativeId);
        if (!thread || !controlled.has(key(provider, nativeId))) return;
        if (thread.ownership !== 'managed' || thread.runtimeEpoch !== epoch) {
          context.asyncInputs.emit({
            kind: 'recovery',
            provider,
            source: null,
            reason: 'output-gap',
          });
          return;
        }
        const source = {
          threadId: thread.id,
          provider,
          nativeId,
          workspaceRoot: thread.workspaceRoot,
        };
        context.asyncInputs.emit(
          item
            ? { kind: 'item', source, item }
            : { kind: 'recovery', provider, source, reason: 'output-gap' },
        );
      },
      source,
    );
  };

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

  /** Contains evidence loss only with a current trusted Claude controller and existing owner. */
  const quarantineSource = (
    provider: IManagedThread['provider'],
    source: IControlSource | undefined,
    hasEvidenceFailure = false,
    cause?: unknown,
  ): boolean => {
    if (provider !== 'claude' || !source || !registry.isCurrentControl(provider, source))
      return false;
    const owner = controlled.get(key(provider, source.nativeId));
    if (!owner) return false;
    if (owner.quarantine?.source.scope !== source.scope)
      owner.quarantine = { source, hasEvidenceFailure: false, hasNotice: false };
    owner.quarantine.hasEvidenceFailure ||= hasEvidenceFailure;
    return registry.quarantineControl(provider, source, cause);
  };

  /** Contains native protocol failures to the affected controller before releasing its transport. */
  const runNativeOwned = (
    provider: IManagedThread['provider'],
    nativeId: string | undefined,
    operation: () => Promise<void>,
    controlScope?: string,
    source?: IControlSource,
  ): void => {
    const expectedControl = nativeId ? controlled.get(key(provider, nativeId)) : undefined;
    runOwned(async () => {
      try {
        await operation();
      } catch (cause) {
        if (expectedControl && controlled.get(key(provider, nativeId!)) !== expectedControl) return;
        const isFatal =
          isException(cause) &&
          (cause.code === 'JG_AGENT_HQ_TRANSPORT_FAILED' ||
            cause.code === 'JG_AGENT_HQ_STORE_FAILED');
        if (!isFatal && quarantineSource(provider, source, false, cause)) return;
        await recordObservation({
          kind: 'native-unavailable',
          provider,
          ...(nativeId ? { nativeThreadId: nativeId } : {}),
        });
        try {
          await stopFailedControl(provider, nativeId, controlScope, expectedControl);
        } catch {
          // failed cleanup remains with its controller and cannot establish stopped ownership
        }
      }
    });
  };
  /** Orders lifecycle persistence without buffering an unbounded stream. */
  const enqueue = (
    provider: IManagedThread['provider'],
    operation: () => Promise<void>,
    source?: IControlSource,
  ): void => {
    if (state.isUnavailable || context.blockedProviders.has(provider)) return;
    if (source && !registry.isCurrentControl(provider, source)) return;
    if ((eventCounts.get(provider) ?? 0) >= 128) {
      if (quarantineSource(provider, source, true)) return;
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
        if (
          source &&
          (!registry.isCurrentControl(provider, source) ||
            controlled.get(key(provider, source.nativeId))?.quarantine?.hasEvidenceFailure)
        )
          return;
        await operation();
      } finally {
        const pending = (eventCounts.get(provider) ?? 1) - 1;
        if (pending) eventCounts.set(provider, pending);
        else eventCounts.delete(provider);
      }
    });
    void state.lane.catch((error) => {
      if (
        (getErrorKind(error) === 'state-conflict' ||
          error instanceof z.ZodError ||
          (isException(error) && error.cause instanceof z.ZodError)) &&
        quarantineSource(provider, source, true, error)
      )
        return;
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

  /**
   * Settles proven shutdown only while the same in-memory owner still names that conversation.
   * @returns Completion after release, or no change for stale or competing ownership.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const settleStoppedControl = async (
    stopped: IStoppedControl,
    expectedControl: IOwnedControl,
  ): Promise<void> => {
    const liveKey = key(expectedControl.provider, expectedControl.nativeId);
    if (expectedControl.provider !== 'claude' || controlled.get(liveKey) !== expectedControl)
      return;
    try {
      if (state.isClosing || context.claudeTerminalOf(stopped.nativeId)) return;
      const thread = await store.call('reads', 'getThreadByNativeId', 'claude', stopped.nativeId);
      if (
        !thread ||
        thread.runtimeEpoch !== epoch ||
        thread.workspaceRoot !== stopped.workspaceRoot ||
        controlled.get(liveKey) !== expectedControl ||
        context.claudeTerminalOf(stopped.nativeId)
      )
        return;
      const released = await store.call(
        'lifecycle',
        'releaseControl',
        thread.id,
        stopped.nativeId,
        stopped.workspaceRoot,
        epoch,
      );
      if (released) waits.notifyThread(thread.id);
    } finally {
      // proof released this old controller even when its ledger ownership has since changed
      if (controlled.get(liveKey) === expectedControl) {
        controlled.delete(liveKey);
        watched.delete(liveKey);
        for (const [id, prompt] of prompts)
          if (
            prompt.native.provider === 'claude' &&
            prompt.native.nativeThreadId === stopped.nativeId
          )
            prompts.delete(id);
      }
    }
  };

  /**
   * Delivers an exact owned shutdown proof to the serialized thread-settlement owner.
   * @returns Confirmed native cleanup with any matching ledger release queued behind prior evidence.
   * @throws
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  const stopFailedControl = async (
    provider: IManagedThread['provider'],
    nativeId: string | undefined,
    controlScope: string | undefined,
    expectedControl: IOwnedControl | undefined,
    requiresQuiescence = false,
  ): Promise<void> => {
    if (expectedControl && controlled.get(key(provider, nativeId!)) !== expectedControl) return;
    const stopped = await registry.stopControl(
      provider,
      nativeId,
      controlScope,
      requiresQuiescence,
    );
    if (
      !stopped ||
      !expectedControl ||
      provider !== 'claude' ||
      stopped.nativeId !== nativeId ||
      (controlScope !== undefined && stopped.scope !== controlScope)
    )
      return;
    enqueue(provider, () => settleStoppedControl(stopped, expectedControl));
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
            await correlateEvidenceOrigins(response.result.data, provider, nativeId, store, {
              workspaceRoot,
              onAcknowledged: (threadId) => {
                waits.notifyThread(threadId);
                live.invalidateProvenance(liveKey);
              },
            });
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
    source?: IControlSource,
  ): void => {
    if (
      !('nativeThreadId' in observation) ||
      !observation.nativeThreadId ||
      !controlled.has(key(provider, observation.nativeThreadId))
    )
      return;
    if (observation.kind === 'turn-completed')
      live.completeTurn(key(provider, observation.nativeThreadId), observation.nativeTurnId);
    enqueue(provider, () => observe(observation), source);
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
    quarantined(provider, source) {
      if (state.isClosing || provider !== 'claude' || !registry.isCurrentControl(provider, source))
        return;
      const owner = controlled.get(key(provider, source.nativeId));
      if (!owner || (owner.quarantine?.source.scope === source.scope && owner.quarantine.hasNotice))
        return;
      if (owner.quarantine?.source.scope !== source.scope)
        owner.quarantine = { source, hasEvidenceFailure: false, hasNotice: false };
      owner.quarantine.hasNotice = true;
      live.markGap(key(provider, source.nativeId));
      for (const [id, prompt] of prompts)
        if (prompt.native.provider === provider && prompt.native.nativeThreadId === source.nativeId)
          prompts.delete(id);
      context.asyncInputs.emit({ kind: 'recovery', provider, source: null, reason: 'output-gap' });
      // one control transition per owned slot follows prior valid evidence outside the native-event cap
      const previous = state.lane;
      state.lane = runBackground(async () => {
        await previous.catch(() => undefined);
        const thread = await store.call('reads', 'getThreadByNativeId', provider, source.nativeId);
        if (
          controlled.get(key(provider, source.nativeId)) !== owner ||
          !registry.isCurrentControl(provider, source) ||
          thread?.runtimeEpoch !== epoch ||
          thread.workspaceRoot !== source.workspaceRoot
        )
          return;
        await recordObservation({
          kind: 'native-unavailable',
          provider,
          nativeThreadId: source.nativeId,
        });
      });
      void state.lane.catch(failEvents);
    },
    quiescent(provider, source) {
      if (
        state.isClosing ||
        !registry.isCurrentControl(provider, source) ||
        !registry.isControlQuarantined(provider, source)
      )
        return;
      const owner = controlled.get(key(provider, source.nativeId));
      if (!owner) return;
      runOwned(async () => {
        try {
          await state.lane.catch(() => undefined);
          if (
            controlled.get(key(provider, source.nativeId)) !== owner ||
            !registry.isCurrentControl(provider, source)
          )
            return;
          await stopFailedControl(provider, source.nativeId, source.scope, owner, true);
        } catch (cause) {
          // stale proof leaves work alive; an unconfirmed close stays on its retained controller
          if (
            isException(cause) &&
            [
              'JG_AGENT_HQ_ACTION_CONFLICT',
              'JG_AGENT_HQ_TRANSPORT_FAILED',
              'JG_AGENT_HQ_CLAUDE_FAILED',
              'JG_AGENT_HQ_PROVIDER_FAILED',
            ].includes(cause.code)
          )
            return;
          failEvents(cause);
        }
      });
    },
    resync(provider, nativeId, lost) {
      if (state.isClosing) return;
      context.asyncInputs.emit({ kind: 'recovery', provider, source: null, reason: 'output-gap' });
      const request: IResyncRequest = { lost, isLastAttempt: false, turnId: null };
      // without a session, every session this runtime controls through the provider is read
      if (nativeId === undefined) {
        for (const thread of controlled.values())
          if (thread.provider === provider) resyncs.request(provider, thread.nativeId, request);
      } else if (controlled.has(key(provider, nativeId)))
        resyncs.request(provider, nativeId, request);
    },
    // a live item stays in the window, which keeps one entry per item, and never reaches the store
    item(provider, nativeId, item, isComplete, replacedIds, source) {
      if (!controlled.has(key(provider, nativeId))) return;
      for (const replacedId of replacedIds ?? [])
        live.replace(key(provider, nativeId), item.turnId, replacedId);
      live.put(key(provider, nativeId), item, isComplete);
      if (isComplete && item.asyncInput) observeAsyncInput(provider, nativeId, item, source);
    },
    gap(provider, nativeId, source) {
      if (controlled.has(key(provider, nativeId))) {
        live.markGap(key(provider, nativeId));
        observeAsyncInput(provider, nativeId, undefined, source);
      }
    },
    background(provider, nativeId, count) {
      if (controlled.has(key(provider, nativeId)))
        live.setBackgroundCommands(key(provider, nativeId), count);
    },
    session(provider, nativeId, sessionState, thread, source) {
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
      }
      // the store suppresses controlled observations and retains status for uncertain controls
      enqueue(
        provider,
        () =>
          store.call(
            'sessions',
            'observe',
            provider,
            [{ nativeId, state: sessionState, thread }],
            false,
          ),
        source,
      );
    },
    delta(provider, nativeId, turnId, itemId, text) {
      if (controlled.has(key(provider, nativeId)))
        live.append(key(provider, nativeId), turnId, itemId, text);
    },
    prompt(provider, prompt, source) {
      // a session that outlives the runtime keeps its request for the next runtime to answer
      if (state.isClosing && keepsSessions(provider)) return;
      // the client driving a session HQ doesn't control answers its requests, so HQ stays silent
      if (!controlled.has(key(provider, prompt.nativeThreadId))) return;
      if (prompts.size >= 32 && quarantineSource(provider, source, true)) return;
      if (prompts.size >= 32 || state.isClosing) {
        runNativeOwned(provider, prompt.nativeThreadId, prompt.reject, source?.scope, source);
        return;
      }
      enqueue(
        provider,
        async () => {
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
        },
        source,
      );
    },
    unpresentable(provider, nativeId, reject, source) {
      if (state.isClosing && keepsSessions(provider)) return;
      // only a session HQ controls waits on HQ for an answer
      if (!controlled.has(key(provider, nativeId))) return;
      runNativeOwned(provider, nativeId, reject, source?.scope, source);
    },
    outcome(provider, outcome, nativeThread, source) {
      if (state.isClosing) return;
      enqueue(
        provider,
        async () => {
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
          if (
            source &&
            (thread.runtimeEpoch !== epoch ||
              thread.workspaceRoot !== source.workspaceRoot ||
              (thread.nativeId !== source.nativeId &&
                !(
                  outcome.kind === 'created' &&
                  thread.nativeId === null &&
                  nativeThread?.nativeId === source.nativeId
                )))
          )
            conflict();
          let verifiedOutcome = outcome;
          if (nativeThread && (outcome.kind === 'created' || outcome.kind === 'resumed')) {
            if (outcome.kind === 'resumed' && nativeThread.nativeId !== thread.nativeId)
              agentUnavailable();
            const verified = await verifyThread(thread, nativeThread);
            verifiedOutcome = { ...outcome, nativeLineage: verified.nativeLineage };
            if (outcome.kind === 'created') own(provider, verified.nativeId);
          }
          const updated = await apply(verifiedOutcome);
          // a late answer that moved its action to its next phase continues it
          if (updated?.delivery === 'submitted' && updated.phase !== outcome.phase)
            runOwned(async () => {
              const current = await store.call('reads', 'getThread', thread.id);
              if (current) await dispatch(updated, current);
            });
        },
        source,
      );
    },
    unavailable(provider, nativeId, controlScope) {
      if (state.isClosing || context.blockedProviders.has(provider)) return;
      const expectedControl = nativeId ? controlled.get(key(provider, nativeId)) : undefined;
      context.asyncInputs.emit({ kind: 'recovery', provider, source: null, reason: 'output-gap' });
      const canReconnect = provider === 'codex' && nativeId === undefined;
      let reconnectable: IManagedThread[] = [];
      enqueue(provider, async () => {
        if (expectedControl && controlled.get(key(provider, nativeId!)) !== expectedControl) return;
        if (canReconnect) reconnectable = await store.call('lifecycle', 'listReconnectable');
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
        for (const entry of controlled.values())
          if (entry.provider === provider && (!nativeId || entry.nativeId === nativeId))
            live.markGap(key(provider, entry.nativeId));
      });
      if (canReconnect) {
        const persisted = state.lane;
        runOwned(async () => {
          await persisted;
          if (!state.isClosing && !state.isUnavailable && !context.blockedProviders.has(provider)) {
            await reconnect(reconnectable);
            context.asyncInputs.emit({
              kind: 'recovery',
              provider,
              source: null,
              reason: 'reconnect',
            });
          }
        });
      } else
        runNativeOwned(
          provider,
          nativeId,
          () => stopFailedControl(provider, nativeId, controlScope, expectedControl),
          controlScope,
        );
    },
  });

  /**
   * Serializes an ended operation's exact reservation release after its quarantine notice.
   * @returns Completion of the matching release, or no change for a replaced controller/action.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const finishControlAction = async (
    actionId: string,
    owner: IOwnedControl | undefined,
  ): Promise<void> => {
    const quarantine = owner?.quarantine;
    if (!owner || !quarantine?.hasNotice || owner.provider !== 'claude') return;
    const { source } = quarantine;
    const liveKey = key(owner.provider, owner.nativeId);
    const previous = state.lane;
    state.lane = runBackground(async () => {
      await previous.catch(() => undefined);
      if (controlled.get(liveKey) !== owner || !registry.isCurrentControl('claude', source)) return;
      const released = await store.call(
        'lifecycle',
        'releaseEndedControlAction',
        actionId,
        source.nativeId,
        source.workspaceRoot,
        epoch,
      );
      if (released) waits.notifyThread(released.id);
    });
    void state.lane.catch(failEvents);
    await state.lane;
  };

  return { recordObservation, failEvents, enqueue, observe, finishControlAction };
};
