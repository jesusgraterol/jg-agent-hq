import { randomUUID } from 'node:crypto';
import { Exception, extractMessage } from 'jg-exception';
import { createTaskRunner } from 'jg-utilities';

import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  INativeApproval,
  INativeApprovalSummary,
  ISessionTerminal,
} from '../contracts/index.js';
import { MAX_CONNECTIONS } from '../ipc/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import type { createSkills } from '../skills/index.js';
import type { IStore } from '../store/index.js';

import { LiveItems } from './live/index.js';
import { ActionWaits, ChangeWaits } from './waits/index.js';
import { createDispatch } from './dispatch/index.js';
import { createEvents } from './events/index.js';
import { createAdmission } from './admission/index.js';
import { createReattach } from './reattach/index.js';
import type { IActionsContext, IPollTopic } from './types.js';
import { keepsSessions } from './utilities.js';

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
  claudeTerminalOf: (nativeId: string) => ISessionTerminal | null,
) => {
  const admissions = new Set<Promise<IActionReceipt>>();
  // native work the runtime owns, which close stops admitting and drains
  const owned = createTaskRunner({ onError: (error) => events.failEvents(error) });
  const key = (provider: IManagedThread['provider'], nativeId: string) =>
    JSON.stringify([provider, nativeId]);
  // over IPC each long-poll holds one of its connections, so as many may wait in process
  const polls = new ChangeWaits<IPollTopic>(MAX_CONNECTIONS);
  const context: IActionsContext = {
    registry,
    store,
    roots,
    epoch,
    actionKey,
    skills,
    runBackground,
    claudeTerminalOf,
    state: {
      isClosing: false,
      isUnavailable: false,
      eventFailure: undefined,
      lane: Promise.resolve(),
      ownedCount: 0,
    },
    prompts: new Map(),
    controlled: new Map(),
    watched: new Set(),
    blockedProviders: new Set(),
    live: new LiveItems(() => polls.notify({ kind: 'live' })),
    waits: new ActionWaits((actionId) => store.call('reads', 'getAction', actionId)),
    polls,
    resyncLifetime: new AbortController(),
    key,
    own(provider, nativeId) {
      context.controlled.set(key(provider, nativeId), { provider, nativeId });
      context.live.open(key(provider, nativeId));
    },
    runOwned(operation) {
      void owned.trigger(async () => {
        context.state.ownedCount += 1;
        try {
          await runBackground(operation);
        } finally {
          context.state.ownedCount -= 1;
        }
      });
    },
  };
  const { state, prompts, controlled, live, waits } = context;
  const dispatcher = createDispatch(context);
  const events = createEvents(context, dispatcher);
  const { admitAndDispatch } = createAdmission(context, dispatcher);
  context.runOwned(createReattach(context, dispatcher, events).reattach);

  return {
    live,
    waits,
    polls,
    /**
     * Returns after durable admission; the native operation outlives this client request, except
     * a deletion, which settles within it and throws its failure.
     * @returns The durable admission receipt after validation, or a deletion's settled receipt.
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
     * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
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
     * Stops admission, interrupts active work, cleans native terminals and confirms shutdown. A
     * session that outlives the runtime keeps running, with its terminals, for the next runtime.
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
      state.isClosing = true;
      context.resyncLifetime.abort();
      let cleanupFailure: unknown;
      try {
        await Promise.allSettled([...admissions]);
        const stopped = [...controlled.values()].filter(({ provider }) => !keepsSessions(provider));
        // Active turn IDs come from ordered native evidence, never from an interrupt acknowledgement.
        await Promise.all(
          stopped.map(async ({ provider, nativeId }) => {
            const thread = await store.call('reads', 'getThreadByNativeId', provider, nativeId);
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
        await owned.close();
        await state.lane.catch(() => undefined);
        const providerStates = new Map(
          registry.statuses().map((status) => [status.provider, status.state]),
        );
        for (const { provider, nativeId } of stopped) {
          if (providerStates.get(provider) === 'unavailable') continue;
          const control = await registry.get(provider);
          if (control.isAvailable) await control.prepareShutdown(nativeId);
        }
      } catch (error) {
        cleanupFailure = error;
      } finally {
        const nativeExit = await Promise.allSettled([registry.close()]);
        await owned.close();
        await state.lane.catch(() => undefined);
        const failedExit = nativeExit.find((result) => result.status === 'rejected');
        if (failedExit?.status === 'rejected')
          throw new Exception(`The HQ transport failed: ${extractMessage(failedExit.reason)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'operation-failed' },
            cause: cleanupFailure ?? failedExit.reason,
          });
      }
      if (cleanupFailure) throw cleanupFailure;
      if (state.eventFailure) throw state.eventFailure;
      await store.call('lifecycle', 'releaseControls');
      prompts.clear();
      live.clear();
      controlled.clear();
    },
  };
};
