import { createHmac, randomUUID } from 'node:crypto';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  INativeApproval,
  INativeApprovalSummary,
  IPreparedInput,
  ILoginObservation,
  ISessionTerminal,
} from '../contracts/index.js';
import { getErrorKind } from '../errors/index.js';
import type { INativePrompt, IProviderThread } from '../providers/index.js';
import { retainNativeLineage, readInputFiles } from '../providers/index.js';
import { capabilityUnavailable, type createProviderRegistry } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { createSkills } from '../skills/index.js';
import type { IStore } from '../store/index.js';
import type { INativeOutcome, INativeObservation, IAdmission } from '../store/control/index.js';

import { LiveItems } from './live/index.js';

const NativeRejectionSchema = z.union([
  z.object({ nativeCode: z.number() }),
  z.object({ nativeRejection: z.literal(true) }),
]);
/**
 * Owns admitted native work across client disconnects, with durable delivery evidence.
 * @returns The runtime-scoped action controller. Close must precede worker shutdown.
 */
export const createActions = (
  registry: ReturnType<typeof createProviderRegistry>,
  store: IStore,
  roots: string[],
  epoch: string,
  actionKey: Uint8Array,
  skills: ReturnType<typeof createSkills>,
  runBackground: (operation: () => Promise<void>) => Promise<void>,
  invalidateNativeCatalogs: () => void,
  claudeTerminalOf: (nativeId: string) => ISessionTerminal | null,
) => {
  const prompts = new Map<string, { native: INativePrompt; threadId: string }>();
  const controlled = new Map<string, { provider: IManagedThread['provider']; nativeId: string }>();
  const key = (provider: IManagedThread['provider'], nativeId: string) =>
    JSON.stringify([provider, nativeId]);
  const own = (provider: IManagedThread['provider'], nativeId: string): void => {
    controlled.set(key(provider, nativeId), { provider, nativeId });
    live.open(key(provider, nativeId));
  };
  const live = new LiveItems();
  const tasks = new Set<Promise<void>>();
  const admissions = new Set<Promise<IActionReceipt>>();
  let lane = Promise.resolve();
  const eventCounts = new Map<IManagedThread['provider'], number>();
  const blockedProviders = new Set<IManagedThread['provider']>();
  // providers whose connection reports the sessions other clients drive
  const observingProviders = new Set<IManagedThread['provider']>();
  let closing = false;
  let unavailable = false;
  let eventFailure: unknown;

  const conflict: () => never = () => {
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: {
        kind: 'state-conflict',
      },
    });
  };
  const agentUnavailable: () => never = () => {
    throw new Exception('The HQ provider integration failed', {
      code: 'JG_AGENT_HQ_PROVIDER_FAILED',
      data: { kind: 'agent-unavailable' },
    });
  };

  /** Quarantines controls after a lifecycle gap and stops the native transport. */
  const failEvents = (cause?: unknown): void => {
    if (unavailable) return;
    unavailable = true;
    eventFailure = cause;
    prompts.clear();
    const previous = lane;
    lane = runBackground(async () => {
      await previous.catch(() => undefined);
      for (const { provider } of registry.statuses())
        await store.observe({ kind: 'native-unavailable', provider });
    });
    void lane.catch((error: unknown) => {
      eventFailure = error;
    });
    void registry.close().catch((error: unknown) => {
      eventFailure = error;
    });
  };

  /** Stops one event source after its bounded lane loses lifecycle evidence. */
  const failProvider = (provider: IManagedThread['provider'], cause: unknown): void => {
    if (blockedProviders.has(provider)) return;
    blockedProviders.add(provider);
    for (const [id, prompt] of prompts) if (prompt.native.provider === provider) prompts.delete(id);
    const previous = lane;
    lane = runBackground(async () => {
      await previous.catch(() => undefined);
      await store.observe({ kind: 'native-unavailable', provider });
    });
    void lane.catch(failEvents);
    registry.quarantine(provider, cause);
  };

  /** Keeps native work owned by the runtime when a requesting client disconnects. */
  const runOwned = (operation: () => Promise<void>): void => {
    const task = (async () => {
      try {
        await runBackground(operation);
      } catch (error) {
        failEvents(error);
      }
    })();
    tasks.add(task);
    void task
      .finally(() => {
        tasks.delete(task);
      })
      .catch(failEvents);
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
        await store.observe({
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
    if (unavailable || blockedProviders.has(provider)) return;
    if ((eventCounts.get(provider) ?? 0) >= 128) {
      failProvider(
        provider,
        new Exception('The HQ provider integration failed', {
          code: 'JG_AGENT_HQ_PROVIDER_FAILED',
          data: { kind: 'agent-unavailable' },
        }),
      );
      return;
    }
    eventCounts.set(provider, (eventCounts.get(provider) ?? 0) + 1);
    const previous = lane;
    lane = runBackground(async () => {
      try {
        await previous.catch(() => undefined);
        if (unavailable) return;
        await operation();
      } finally {
        const pending = (eventCounts.get(provider) ?? 1) - 1;
        if (pending) eventCounts.set(provider, pending);
        else eventCounts.delete(provider);
      }
    });
    void lane.catch((error) => {
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

  const validateRoot = async (thread: IManagedThread): Promise<void> => {
    if ((await resolveWorkspaceTarget(thread.workspaceRoot, roots)) !== thread.workspaceRoot)
      conflict();
  };

  /**
   * Verifies native workspace and lineage before binding them to a managed identity.
   * @returns The verified metadata with confirmed lineage retained.
   * @throws
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const verifyThread = async (
    thread: IManagedThread,
    native: IProviderThread,
  ): Promise<IProviderThread> => {
    try {
      if ((await resolveWorkspaceTarget(native.workspaceRoot, roots)) !== thread.workspaceRoot)
        agentUnavailable();
      const existing = await store.getThreadByNativeId(thread.provider, native.nativeId);
      if (existing && existing.id !== thread.id) agentUnavailable();
      const nativeLineage = retainNativeLineage(thread.nativeLineage, native.nativeLineage);
      if (thread.forkedFromThreadId) {
        const source = await store.getThread(thread.forkedFromThreadId);
        if (!source?.nativeId || nativeLineage?.forkedFromId !== source.nativeId)
          agentUnavailable();
      }
      return { ...native, nativeLineage };
    } catch (cause) {
      registry.quarantine(thread.provider, cause);
      throw cause;
    }
  };

  /** Lets the worker claim one ready entry atomically without locking a turn’s lifetime. */
  const advanceQueue = (threadId: string, provider: IManagedThread['provider']): void => {
    if (closing || unavailable || blockedProviders.has(provider)) return;
    runOwned(async () => {
      const next = await store.claimQueued(threadId);
      if (next)
        await dispatch(
          next.receipt,
          next.thread,
          {
            kind: 'message',
            threadId,
            input: { kind: 'text', text: next.input.text },
            settings: next.input.settings,
          },
          next.input,
        );
    });
  };

  const apply = async (outcome: INativeOutcome): Promise<IActionReceipt | null> => {
    const receipt = await store.applyOutcome(outcome);
    if (!receipt?.threadId) return receipt;
    const thread = await store.getThread(receipt.threadId);
    if (thread?.nativeId && (outcome.kind === 'closed' || outcome.kind === 'archived')) {
      controlled.delete(key(thread.provider, thread.nativeId));
    }
    if (
      thread?.state === 'completed' &&
      outcome.kind !== 'control-accepted' &&
      outcome.kind !== 'control-completed'
    )
      advanceQueue(thread.id, thread.provider);
    return receipt;
  };

  const continuePhases = async (receipt: IActionReceipt, thread: IManagedThread): Promise<void> => {
    const requestId = receipt.nativeRequestId;
    if (!requestId || !thread.nativeId || closing) return;
    if (requestId.endsWith(':name')) {
      const admissionName = receipt.kind === 'thread-rename' ? null : thread.name;
      // rename's new name is retained only by its admitted in-memory command; late name acks need no resend
      if (!admissionName) return;
      await (
        await registry.get(thread.provider)
      ).nameThread(requestId, thread.nativeId, admissionName);
      await apply({ kind: 'renamed', actionId: receipt.id, requestId });
    } else if (requestId.endsWith(':close')) {
      await (await registry.get(thread.provider)).releaseThread(requestId, thread.nativeId);
      await apply({ kind: 'closed', actionId: receipt.id, requestId });
    } else if (requestId.endsWith(':archive')) {
      await (await registry.get(thread.provider)).archiveThread(requestId, thread.nativeId);
      await apply({ kind: 'archived', actionId: receipt.id, requestId });
    }
  };

  /**
   * Dispatches one admitted intent once and records delivery without replaying it.
   * @returns A promise resolved after delivery evidence or uncertainty is persisted.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const dispatch = async (
    initial: IActionReceipt,
    originalThread: IManagedThread,
    command: IActionEnvelope['command'],
    input?: IPreparedInput,
  ): Promise<void> => {
    let receipt = initial;
    let thread = originalThread;
    let hasDispatched = false;
    try {
      const control = await registry.get(thread.provider);
      if (closing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          requestId: receipt.nativeRequestId!,
          failure: 'state-conflict',
        });
        return;
      }
      await validateRoot(thread);
      if (closing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          requestId: receipt.nativeRequestId!,
          failure: 'state-conflict',
        });
        return;
      }
      const requestId = receipt.nativeRequestId;
      if (!requestId) conflict();
      const nativeId = thread.nativeId;
      const prompt = command.kind === 'native-reply' ? prompts.get(command.approvalId) : undefined;
      if (command.kind === 'native-reply' && !prompt) conflict();
      const reply =
        command.kind === 'native-reply' ? prompt!.native.validate(command.response) : undefined;
      const source =
        requestId.endsWith(':fork') && thread.forkedFromThreadId
          ? await store.getThread(thread.forkedFromThreadId)
          : null;
      if (requestId.endsWith(':fork') && !source?.nativeId) conflict();
      hasDispatched = true;
      if (requestId.endsWith(':control')) {
        if (
          !nativeId ||
          ![
            'skills-reload',
            'mcp-reload',
            'mcp-reconnect',
            'mcp-set-enabled',
            'mcp-login',
            'plugins-reload',
          ].includes(command.kind)
        )
          conflict();
        const result = await control.controlExtensions(
          requestId,
          nativeId,
          thread.workspaceRoot,
          command as Extract<
            IActionEnvelope['command'],
            {
              kind:
                | 'skills-reload'
                | 'mcp-reload'
                | 'mcp-reconnect'
                | 'mcp-set-enabled'
                | 'mcp-login'
                | 'plugins-reload';
            }
          >,
        );
        invalidateNativeCatalogs();
        await apply({ kind: 'control-accepted', actionId: receipt.id, requestId, ...result });
      } else if (requestId.endsWith(':create') || requestId.endsWith(':fork')) {
        const created = await verifyThread(
          thread,
          requestId.endsWith(':fork')
            ? await control.forkThread(requestId, source!.nativeId!, thread.workspaceRoot)
            : await control.startThread(
                requestId,
                thread.workspaceRoot,
                command.kind === 'thread-create' ? (command.settings ?? {}) : {},
              ),
        );
        // bind the exact response before attempting the second, independently receipted native phase
        own(thread.provider, created.nativeId);
        receipt = (await apply({
          kind: 'created',
          actionId: receipt.id,
          requestId,
          nativeId: created.nativeId,
          nativeLineage: created.nativeLineage,
        }))!;
        thread = (await store.getThread(thread.id))!;
        await continuePhases(receipt, thread);
      } else if (requestId.endsWith(':resume')) {
        if (!nativeId) conflict();
        own(thread.provider, nativeId);
        const resumed = await verifyThread(
          thread,
          await control.resumeThread(
            requestId,
            nativeId,
            thread.workspaceRoot,
            thread.name,
            command.kind === 'thread-resume' ? (command.settings ?? {}) : {},
          ),
        );
        await apply({
          kind: 'resumed',
          actionId: receipt.id,
          requestId,
          nativeState: resumed.nativeState,
          nativeLineage: resumed.nativeLineage,
        });
      } else if (requestId.endsWith(':name')) {
        if (!nativeId || command.kind !== 'thread-rename') conflict();
        await control.nameThread(requestId, nativeId, command.name);
        await apply({ kind: 'renamed', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':unarchive')) {
        if (!nativeId) conflict();
        await verifyThread(thread, await control.unarchiveThread(requestId, nativeId));
        await apply({ kind: 'unarchived', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':revert')) {
        if (!nativeId || command.kind !== 'thread-revert') conflict();
        await verifyThread(
          thread,
          await control.revertThread(requestId, nativeId, command.beforeTurnId),
        );
        live.reset(key(thread.provider, nativeId));
        await apply({ kind: 'reverted', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':compact')) {
        if (!nativeId) conflict();
        live.reset(key(thread.provider, nativeId));
        const turn = await control.compactThread(requestId, nativeId);
        await apply({
          kind: 'compaction-accepted',
          actionId: receipt.id,
          requestId,
          nativeTurnId: turn.id,
        });
      } else if (requestId.endsWith(':turn')) {
        if (!nativeId || !input) conflict();
        hasDispatched = false;
        const files = await readInputFiles(input.files, thread.workspaceRoot, roots);
        await control.validateInput(nativeId, input);
        hasDispatched = true;
        const turn = await control.startTurn(
          requestId,
          nativeId,
          input.text,
          input.skill,
          input.settings,
          files,
        );
        await apply({
          kind: 'turn-accepted',
          actionId: receipt.id,
          requestId,
          nativeTurnId: turn.id,
        });
      } else if (requestId.endsWith(':steer')) {
        if (!nativeId || command.kind !== 'steer') conflict();
        const nativeTurnId = await control.steer(
          requestId,
          nativeId,
          command.expectedTurnId,
          command.text,
        );
        await apply({ kind: 'steer-accepted', actionId: receipt.id, requestId, nativeTurnId });
      } else if (requestId.endsWith(':interrupt')) {
        if (!nativeId || command.kind !== 'interrupt') conflict();
        await control.interrupt(requestId, nativeId, command.expectedTurnId);
        await apply({ kind: 'interrupt-accepted', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':clean')) {
        if (!nativeId) conflict();
        await control.cleanThread(requestId, nativeId);
        receipt = (await apply({ kind: 'cleaned', actionId: receipt.id, requestId }))!;
        await continuePhases(receipt, thread);
      } else if (command.kind === 'native-reply') {
        await prompt!.native.reply(reply);
        await apply({ kind: 'reply-written', actionId: receipt.id, requestId });
      }
    } catch (error) {
      // Only a matching native error response proves rejection. Transport loss and malformed results remain uncertain.
      const explicit =
        isException(error) &&
        (NativeRejectionSchema.safeParse(error.data).success ||
          error.code === 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE');
      const kind = getErrorKind(error);
      const failure =
        kind === 'state-conflict' || kind === 'access-denied' || kind === 'agent-unavailable'
          ? kind
          : 'operation-failed';
      await apply(
        !hasDispatched || explicit
          ? {
              kind: 'failed',
              actionId: receipt.id,
              requestId: receipt.nativeRequestId!,
              failure: explicit ? 'agent-unavailable' : failure,
            }
          : { kind: 'uncertain', actionId: receipt.id, requestId: receipt.nativeRequestId! },
      );
    }
  };

  const observe = async (observation: INativeObservation): Promise<void> => {
    const result = await store.observe(observation);
    if (observation.kind === 'turn-completed') {
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
  };

  registry.setEvents({
    observe(provider, observation) {
      if (
        !('nativeThreadId' in observation) ||
        !observation.nativeThreadId ||
        !controlled.has(key(provider, observation.nativeThreadId))
      )
        return;
      if (observation.kind === 'turn-completed')
        live.completeTurn(key(provider, observation.nativeThreadId), observation.nativeTurnId);
      enqueue(provider, () => observe(observation));
    },
    item(provider, nativeId, item, isComplete, replacedIds) {
      if (!controlled.has(key(provider, nativeId))) return;
      for (const replacedId of replacedIds ?? [])
        live.replace(key(provider, nativeId), item.turnId, replacedId);
      live.put(key(provider, nativeId), item, isComplete);
      enqueue(provider, () =>
        observe({
          kind: isComplete ? 'item-completed' : 'item-started',
          provider,
          nativeThreadId: nativeId,
          nativeTurnId: item.turnId,
          nativeItemId: item.nativeId,
        }),
      );
    },
    gap(provider, nativeId) {
      if (controlled.has(key(provider, nativeId))) live.markGap(key(provider, nativeId));
    },
    session(provider, nativeId, state) {
      observingProviders.add(provider);
      // a session this runtime controls reports its transitions through its own thread state
      if (controlled.has(key(provider, nativeId))) return;
      enqueue(provider, () => store.observeSessions(provider, [{ nativeId, state }], false));
    },
    delta(provider, nativeId, turnId, itemId, text) {
      if (controlled.has(key(provider, nativeId)))
        live.append(key(provider, nativeId), turnId, itemId, text);
    },
    prompt(provider, prompt) {
      if (!controlled.has(key(provider, prompt.nativeThreadId)) || prompts.size >= 32 || closing) {
        runNativeOwned(provider, prompt.nativeThreadId, prompt.reject);
        return;
      }
      enqueue(provider, async () => {
        const recorded = await store.openApproval({
          id: randomUUID(),
          provider,
          nativeThreadId: prompt.nativeThreadId,
          nativeTurnId: prompt.nativeTurnId,
          requestId: prompt.requestId,
          kind: prompt.presentation.kind,
          isBlocking: prompt.presentation.isBlocking,
          digest: createHmac('sha256', actionKey).update(prompt.fingerprint).digest('hex'),
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
    outcome(provider, outcome, nativeThread) {
      if (closing) return;
      enqueue(provider, async () => {
        const receipt = await store.getAction(outcome.actionId);
        if (
          !receipt ||
          receipt.runtimeEpoch !== epoch ||
          receipt.nativeRequestId !== outcome.requestId ||
          (!['submitted', 'uncertain'].includes(receipt.delivery) &&
            !(
              outcome.kind === 'control-completed' &&
              receipt.delivery === 'acknowledged' &&
              receipt.completion === null
            )) ||
          receipt.provider !== provider
        )
          return;
        if (outcome.kind === 'control-accepted' || outcome.kind === 'control-completed') {
          invalidateNativeCatalogs();
          await apply(outcome);
          return;
        }
        if (!receipt.threadId) return;
        const thread = await store.getThread(receipt.threadId);
        if (!thread || thread.provider !== provider) return;
        let verifiedOutcome = outcome;
        if (
          nativeThread &&
          (outcome.kind === 'created' ||
            outcome.kind === 'resumed' ||
            outcome.kind === 'reverted' ||
            outcome.kind === 'unarchived')
        ) {
          if (outcome.kind !== 'created' && nativeThread.nativeId !== thread.nativeId)
            agentUnavailable();
          const verified = await verifyThread(thread, nativeThread);
          if (outcome.kind === 'created' || outcome.kind === 'resumed')
            verifiedOutcome = { ...outcome, nativeLineage: verified.nativeLineage };
          if (outcome.kind === 'created') own(provider, verified.nativeId);
          if (outcome.kind === 'reverted') live.reset(key(provider, verified.nativeId));
        }
        const updated = await apply(verifiedOutcome);
        if (updated && (outcome.kind === 'created' || outcome.kind === 'cleaned'))
          runNativeOwned(
            provider,
            nativeThread?.nativeId ?? thread.nativeId ?? undefined,
            async () => continuePhases(updated, (await store.getThread(thread.id))!),
          );
      });
    },
    unavailable(provider, nativeId) {
      if (closing || blockedProviders.has(provider)) return;
      enqueue(provider, async () => {
        await store.observe({
          kind: 'native-unavailable',
          provider,
          ...(nativeId ? { nativeThreadId: nativeId } : {}),
        });
        // only sessions observed through the lost connection lose their known state
        if (!nativeId && observingProviders.has(provider))
          await store.markSessionsUnknown(provider);
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

  /**
   * Validates the current target and separates new dispatch from idempotent receipt reads.
   * @returns The durable admission receipt; native work runs independently.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const admitAndDispatch = async (action: IActionEnvelope): Promise<IActionReceipt> => {
    // The worker verifies the complete digest before returning any existing receipt.
    const existing = await store.getAction(action.id);
    if (existing) {
      if (existing.threadId) {
        const thread = await store.getThread(existing.threadId);
        if (thread) await validateRoot(thread);
      }
      return (await store.admit({ action, prepared: {} })).receipt;
    }
    if (closing || unavailable || tasks.size >= 64) agentUnavailable();
    const command = action.command;
    let provider: IManagedThread['provider'] | undefined =
      'provider' in command ? command.provider : undefined;
    const prepared: IAdmission['prepared'] = {};
    let input: IPreparedInput | undefined;
    if ('threadId' in command) {
      const target = await store.getThread(command.threadId);
      if (target) {
        await validateRoot(target);
        provider = target.provider;
      }
    } else if ('queuedActionId' in command) {
      const queued = await store.getAction(command.queuedActionId);
      const target = queued?.threadId ? await store.getThread(queued.threadId) : null;
      if (target) {
        await validateRoot(target);
        provider = target.provider;
      }
    }
    if (!provider) return (await store.admit({ action, prepared })).receipt;
    const control = await registry.get(provider);
    if (!control.isAvailable) agentUnavailable();
    if (
      command.kind === 'account-login' ||
      command.kind === 'account-login-cancel' ||
      command.kind === 'account-logout'
    ) {
      const capabilities = await control.readCapabilities(undefined);
      const operation =
        command.kind === 'account-login'
          ? 'accountLogin'
          : command.kind === 'account-login-cancel'
            ? 'accountLoginCancel'
            : 'accountLogout';
      if (capabilities.operations[operation].state !== 'supported') capabilityUnavailable();
      const admitted = await store.admit({ action, prepared });
      if (admitted.isNew && admitted.dispatchActionId) {
        runOwned(async () => {
          let hasDispatched = false;
          try {
            const login =
              command.kind === 'account-login-cancel'
                ? await store.getAction(command.loginActionId)
                : null;
            if (
              command.kind === 'account-login-cancel' &&
              (!login?.nativeRequestId ||
                login.provider !== provider ||
                login.runtimeEpoch !== epoch)
            )
              conflict();
            hasDispatched = true;
            const result = await control.controlAccount(
              admitted.receipt.nativeRequestId!,
              command,
              login?.nativeRequestId ?? undefined,
            );
            invalidateNativeCatalogs();
            await apply({
              kind: 'control-accepted',
              actionId: action.id,
              requestId: admitted.receipt.nativeRequestId!,
              ...result,
            });
          } catch (error) {
            const explicit =
              isException(error) &&
              (NativeRejectionSchema.safeParse(error.data).success ||
                error.code === 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE' ||
                error.code === 'JG_AGENT_HQ_ACTION_CONFLICT');
            await apply(
              !hasDispatched || explicit
                ? {
                    kind: 'failed',
                    actionId: action.id,
                    requestId: admitted.receipt.nativeRequestId!,
                    failure:
                      getErrorKind(error) === 'state-conflict'
                        ? 'state-conflict'
                        : 'agent-unavailable',
                  }
                : {
                    kind: 'uncertain',
                    actionId: action.id,
                    requestId: admitted.receipt.nativeRequestId!,
                  },
            );
          }
        });
      }
      return admitted.receipt;
    }
    if (
      command.kind === 'skills-reload' ||
      command.kind === 'mcp-reload' ||
      command.kind === 'mcp-reconnect' ||
      command.kind === 'mcp-set-enabled' ||
      command.kind === 'mcp-login' ||
      command.kind === 'plugins-reload'
    ) {
      const target = await store.getThread(command.threadId);
      const capabilities = await control.readCapabilities(target?.nativeId ?? undefined);
      const operation =
        command.kind === 'skills-reload'
          ? 'skillsReload'
          : command.kind === 'mcp-reload'
            ? 'mcpReload'
            : command.kind === 'mcp-reconnect'
              ? 'mcpReconnect'
              : command.kind === 'mcp-set-enabled'
                ? 'mcpSetEnabled'
                : command.kind === 'mcp-login'
                  ? 'mcpLogin'
                  : 'pluginsReload';
      if (capabilities.operations[operation].state !== 'supported') capabilityUnavailable();
    }
    if (command.kind === 'steer') {
      const capabilities = await control.readCapabilities(
        (await store.getThread(command.threadId))?.nativeId ?? undefined,
      );
      if (capabilities.operations.steer.state !== 'supported') capabilityUnavailable();
    }
    if (
      command.kind === 'thread-archive' ||
      command.kind === 'thread-unarchive' ||
      command.kind === 'thread-compact' ||
      command.kind === 'thread-revert'
    ) {
      const capabilities = await control.readCapabilities(
        (await store.getThread(command.threadId))?.nativeId ?? undefined,
      );
      const operation =
        command.kind === 'thread-archive'
          ? 'archive'
          : command.kind === 'thread-unarchive'
            ? 'unarchive'
            : command.kind === 'thread-compact'
              ? 'compact'
              : 'revert';
      if (capabilities.operations[operation].state !== 'supported') capabilityUnavailable();
    }
    if (command.kind === 'thread-create' || command.kind === 'thread-adopt')
      prepared.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    if (command.kind === 'thread-fork') {
      const source = await store.getThread(command.threadId);
      if (!source?.nativeId) conflict();
      const capabilities = await control.readCapabilities(source.nativeId);
      if (capabilities.operations.fork.state !== 'supported') capabilityUnavailable();
      const inspected = await control.inspectThread(source.nativeId, source.workspaceRoot);
      const workspaceRoot = await resolveWorkspaceTarget(inspected.thread.workspaceRoot, roots);
      if (workspaceRoot !== source.workspaceRoot) conflict();
      prepared.workspaceRoot = workspaceRoot;
    }
    if (command.kind === 'thread-adopt') {
      // a terminal that runs a Claude session keeps it; HQ takes it only once it runs nowhere
      if (command.provider === 'claude' && claudeTerminalOf(command.nativeId)) conflict();
      const target = await control.inspectThread(command.nativeId, prepared.workspaceRoot!);
      // nobody holds it, or the client that does is between turns, as a Codex terminal can be
      if (
        (!target.canAdopt && !target.canResume) ||
        (await resolveWorkspaceTarget(target.thread.workspaceRoot, roots)) !==
          prepared.workspaceRoot
      )
        conflict();
      prepared.nativeId = command.nativeId;
    } else if (command.kind === 'thread-resume' || command.kind === 'thread-recover') {
      const thread = await store.getThread(command.threadId);
      if (!thread) conflict();
      await validateRoot(thread);
      const nativeId =
        command.kind === 'thread-recover' && command.recovery.kind === 'attach'
          ? command.recovery.nativeId
          : thread.nativeId;
      if (nativeId && thread.provider === 'claude' && claudeTerminalOf(nativeId)) conflict();
      if (nativeId) {
        const target = await control.inspectThread(nativeId, thread.workspaceRoot);
        const canResume =
          target.canAdopt ||
          (command.kind === 'thread-resume' &&
            thread.state === 'inactive' &&
            thread.ownership === 'managed' &&
            target.canResume);
        if (
          !canResume ||
          (await resolveWorkspaceTarget(target.thread.workspaceRoot, roots)) !==
            thread.workspaceRoot
        )
          conflict();
        prepared.nativeId = nativeId;
      }
    } else if (command.kind === 'native-reply') {
      const prompt = prompts.get(command.approvalId);
      if (
        !prompt ||
        prompt.threadId !== command.threadId ||
        prompt.native.nativeTurnId !== command.expectedTurnId
      )
        conflict();
      prompt.native.validate(command.response);
    }
    if (command.kind === 'message' || command.kind === 'queue') {
      const thread = await store.getThread(command.threadId);
      if (!thread?.nativeId) conflict();
      // a terminal that resumed a Claude session HQ runs has it now, so HQ sends nothing
      if (thread.provider === 'claude' && claudeTerminalOf(thread.nativeId)) conflict();
      const files = await readInputFiles(command.input.files ?? [], thread.workspaceRoot, roots);
      input = {
        ...(await skills.prepare(command.threadId, command.input)),
        files: files.map(({ content: _content, ...reference }) => reference),
        settings: command.settings ?? {},
      };
      await control.validateInput(thread.nativeId, input);
      prepared.input = input;
    }
    const admitted = await store.admit({ action, prepared });
    if (admitted.isNew && admitted.dispatchActionId && admitted.thread) {
      const receipt =
        admitted.dispatchActionId === admitted.receipt.id
          ? admitted.receipt
          : await store.getAction(admitted.dispatchActionId);
      if (!receipt) conflict();
      let dispatchedCommand = command;
      if (command.kind === 'queue-send') {
        if (!receipt.queuedInput) conflict();
        dispatchedCommand = {
          kind: 'message',
          threadId: admitted.thread.id,
          input: { kind: 'text', text: receipt.queuedInput.text },
          settings: receipt.queuedInput.settings,
        };
        input = receipt.queuedInput;
      }
      runOwned(() => dispatch(receipt, admitted.thread!, dispatchedCommand, input));
    }
    return admitted.receipt;
  };

  return {
    /**
     * Reads live native authentication presentation without replaying an interrupted action.
     * @returns The exact challenge or its known terminal status; restart loses sensitive presentation.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     */
    async readLogin(actionId: string): Promise<ILoginObservation> {
      const receipt = await store.getAction(actionId);
      const absent: ILoginObservation = {
        state: 'unavailable',
        authorizationUrl: null,
        canCancel: false,
        observedAt: null,
      };
      if (
        !receipt?.provider ||
        !['account-login', 'mcp-login'].includes(receipt.kind) ||
        !receipt.nativeRequestId
      )
        return absent;
      if (receipt.threadId) {
        const thread = await store.getThread(receipt.threadId);
        if (!thread) return absent;
        await validateRoot(thread);
      }
      if (receipt.completion !== null)
        return {
          state:
            receipt.completion === 'completed'
              ? 'completed'
              : receipt.completion === 'interrupted'
                ? 'canceled'
                : 'failed',
          authorizationUrl: null,
          canCancel: false,
          observedAt: receipt.updatedAt,
        };
      if (receipt.runtimeEpoch !== epoch || receipt.delivery === 'failed') return absent;
      return (await registry.get(receipt.provider)).readLogin(receipt.nativeRequestId);
    },
    live,
    /**
     * Returns after durable admission; the native operation outlives this client request.
     * @returns The durable admission receipt after validation.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
     * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async submit(action: IActionEnvelope): Promise<IActionReceipt> {
      const admission = admitAndDispatch(action);
      admissions.add(admission);
      try {
        return await admission;
      } finally {
        admissions.delete(admission);
      }
    },
    /** Attaches sensitive presentation only to the exact current native request. */
    approvalPresentation(approval: INativeApprovalSummary): INativeApproval {
      const prompt = prompts.get(approval.id);
      const current =
        approval.state === 'pending' &&
        approval.runtimeEpoch === epoch &&
        prompt?.threadId === approval.threadId &&
        prompt.native.nativeTurnId === approval.nativeTurnId;
      return {
        ...approval,
        presentation: current ? structuredClone(prompt.native.presentation) : null,
      };
    },
    /**
     * Stops admission, interrupts active work, cleans native terminals and confirms shutdown.
     * @returns A promise resolved after native exit and release of durable control ownership.
     * @throws
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async close(): Promise<void> {
      closing = true;
      let cleanupFailure: unknown;
      try {
        await Promise.allSettled([...admissions]);
        // Active turn IDs come from ordered native evidence, never from an interrupt acknowledgement.
        await Promise.all(
          [...controlled.values()].map(async ({ provider, nativeId }) => {
            const thread = await store.getThreadByNativeId(provider, nativeId);
            if (thread?.activeTurnId) {
              try {
                const control = await registry.get(provider);
                if (control.isAvailable)
                  await control.interrupt(
                    `${randomUUID()}:shutdown`,
                    nativeId,
                    thread.activeTurnId,
                  );
              } catch {
                /* native process termination below remains mandatory */
              }
            }
          }),
        );
        await Promise.allSettled([...tasks]);
        await lane.catch(() => undefined);
        const providerStates = new Map(
          registry.statuses().map((status) => [status.provider, status.state]),
        );
        for (const { provider, nativeId } of controlled.values()) {
          if (providerStates.get(provider) === 'unavailable') continue;
          const control = await registry.get(provider);
          if (control.isAvailable) await control.prepareShutdown(nativeId);
        }
      } catch (error) {
        cleanupFailure = error;
      } finally {
        const nativeExit = await Promise.allSettled([registry.close()]);
        await Promise.allSettled([...tasks]);
        await lane.catch(() => undefined);
        const failedExit = nativeExit.find((result) => result.status === 'rejected');
        if (failedExit?.status === 'rejected')
          throw new Exception(`The HQ transport failed: ${extractMessage(failedExit.reason)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'operation-failed' },
            cause: cleanupFailure ?? failedExit.reason,
          });
      }
      if (cleanupFailure) throw cleanupFailure;
      if (eventFailure) throw eventFailure;
      await store.releaseControls();
      prompts.clear();
      live.clear();
      controlled.clear();
    },
  };
};
