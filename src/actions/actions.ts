import { createHmac, randomUUID } from 'node:crypto';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';
import { setTimeout as wait } from 'node:timers/promises';

import type {
  IActionEnvelope,
  IActionReceipt,
  IThreadSummary,
  IManagedThread,
  INativeApproval,
  INativeSkillInput,
  IPlanRevisionWorkflow,
} from '../contracts/index.js';
import { getErrorKind } from '../errors/index.js';
import {
  NativeThreadSchema,
  NativeTurnSchema,
  NativeItemSchema,
  toHistoryItem,
  parseNative,
  parseCodexPrompt,
  buildCodexReply,
  toApprovalPresentation,
  createClaudeControl,
  type INativePrompt,
  type ICodexProvider,
} from '../providers/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { createSkills } from '../skills/index.js';
import type { IStore } from '../store/index.js';
import type { createPlans } from '../plans/index.js';
import type { INativeOutcome, INativeObservation } from '../store/control/index.js';

import { LiveItems } from './live/index.js';

const TargetSchema = z.object({
  threadId: z.string().min(1).max(4096),
  turnId: z.string().min(1).max(4096),
});
const DeltaSchema = TargetSchema.extend({ itemId: z.string().min(1).max(4096), delta: z.string() });
const NativeRejectionSchema = z.union([
  z.object({ nativeCode: z.number() }),
  z.object({ nativeRejection: z.literal(true) }),
]);
const PhaseIdSchema = z
  .string()
  .regex(/^[a-f0-9-]{36}:(create|resume|name|turn|steer|interrupt|clean|close)$/);

/**
 * Owns admitted native work across client disconnects, with durable delivery evidence.
 * @returns The runtime-scoped action controller. Close must precede worker shutdown.
 */
export const createActions = (
  native: ICodexProvider,
  claude: ReturnType<typeof createClaudeControl>,
  readClaudeThread: (nativeId: string, workspaceRoot: string) => Promise<IThreadSummary>,
  store: IStore,
  roots: string[],
  epoch: string,
  actionKey: Uint8Array,
  skills: ReturnType<typeof createSkills>,
  plans: ReturnType<typeof createPlans>,
  runBackground: (operation: () => Promise<void>) => Promise<void>,
) => {
  const prompts = new Map<string, { native: INativePrompt; presentation: INativeApproval }>();
  const controlled = new Map<string, { provider: IManagedThread['provider']; nativeId: string }>();
  const key = (provider: IManagedThread['provider'], nativeId: string) =>
    JSON.stringify([provider, nativeId]);
  const own = (provider: IManagedThread['provider'], nativeId: string): void => {
    controlled.set(key(provider, nativeId), { provider, nativeId });
    live.open(key(provider, nativeId));
  };
  const live = new LiveItems();
  const tasks = new Set<Promise<void>>();
  const taskOwners = new Map<Promise<void>, string>();
  const admissions = new Set<Promise<IActionReceipt>>();
  let lane = Promise.resolve();
  let eventCount = 0;
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
    throw new Exception('The Codex integration failed', {
      code: 'JG_AGENT_HQ_CODEX_FAILED',
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
      await store.observe({ kind: 'native-unavailable', provider: 'codex' });
      await store.observe({ kind: 'native-unavailable', provider: 'claude' });
    });
    void lane.catch((error: unknown) => {
      eventFailure = error;
    });
    void Promise.all([native.close(), claude.close()]).catch((error: unknown) => {
      eventFailure = error;
    });
  };

  /** Keeps native work owned by the runtime when a requesting client disconnects. */
  const runOwned = (operation: () => Promise<void>, threadId?: string): void => {
    const task = (async () => {
      try {
        await runBackground(operation);
      } catch (error) {
        failEvents(error);
      }
    })();
    tasks.add(task);
    if (threadId) taskOwners.set(task, threadId);
    void task
      .finally(() => {
        tasks.delete(task);
        taskOwners.delete(task);
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
          ...(provider === 'claude' && nativeId ? { nativeThreadId: nativeId } : {}),
        });
        if (provider === 'codex') await native.close();
        else if (nativeId) await claude.stopSession(`${randomUUID()}:reject`, nativeId);
      }
    });
  };
  /** Orders lifecycle persistence without buffering an unbounded stream. */
  const enqueue = (operation: () => Promise<void>): void => {
    if (unavailable) return;
    if (eventCount >= 128) {
      failEvents(
        new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: { kind: 'agent-unavailable' },
        }),
      );
      return;
    }
    eventCount += 1;
    const previous = lane;
    lane = runBackground(async () => {
      try {
        await previous;
        await operation();
      } finally {
        eventCount -= 1;
      }
    });
    void lane.catch(failEvents);
  };

  const validateRoot = async (thread: IManagedThread): Promise<void> => {
    if ((await resolveWorkspaceTarget(thread.workspaceRoot, roots)) !== thread.workspaceRoot)
      conflict();
  };

  /** Lets the worker claim one ready entry atomically without locking a turn’s lifetime. */
  const advanceQueue = (threadId: string): void => {
    if (closing || unavailable) return;
    runOwned(async () => {
      const next = await plans.claimQueued(threadId);
      if (next)
        await dispatch(
          next.receipt,
          next.thread,
          { kind: 'message', threadId, input: { kind: 'text', text: next.text } },
          { text: next.text, skill: next.skill },
        );
    }, threadId);
  };

  const apply = async (outcome: INativeOutcome): Promise<IActionReceipt | null> => {
    const receipt = await store.applyOutcome(outcome);
    if (!receipt?.threadId) return receipt;
    const thread = await store.getThread(receipt.threadId);
    if (thread?.nativeId && outcome.kind === 'closed') {
      controlled.delete(key(thread.provider, thread.nativeId));
    }
    if (thread?.state === 'completed') advanceQueue(thread.id);
    return receipt;
  };

  const continuePhases = async (receipt: IActionReceipt, thread: IManagedThread): Promise<void> => {
    const requestId = receipt.nativeRequestId;
    if (!requestId || !thread.nativeId || closing) return;
    if (requestId.endsWith(':name')) {
      const admissionName = receipt.kind === 'thread-rename' ? null : thread.name;
      // rename's new name is retained only by its admitted in-memory command; late name acks need no resend
      if (!admissionName) return;
      await (thread.provider === 'codex' ? native : claude).nameThread(
        requestId,
        thread.nativeId,
        admissionName,
      );
      await apply({ kind: 'renamed', actionId: receipt.id, requestId });
    } else if (requestId.endsWith(':close')) {
      if (thread.provider === 'codex') {
        await native.verifyTerminalsClosed(thread.nativeId);
        await native.unsubscribe(requestId, thread.nativeId);
      } else await claude.releaseSession(requestId, thread.nativeId);
      await apply({ kind: 'closed', actionId: receipt.id, requestId });
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
    input?: { text: string; skill: INativeSkillInput | null },
  ): Promise<void> => {
    let receipt = initial;
    let thread = originalThread;
    const control = thread.provider === 'codex' ? native : claude;
    let hasDispatched = false;
    try {
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
      hasDispatched = true;
      if (requestId.endsWith(':create')) {
        const created = await control.startThread(requestId, thread.workspaceRoot);
        // bind the exact response before attempting the second, independently receipted native phase
        own(thread.provider, created.id);
        if ((await resolveWorkspaceTarget(created.cwd, roots)) !== thread.workspaceRoot)
          agentUnavailable();
        receipt = (await apply({
          kind: 'created',
          actionId: receipt.id,
          requestId,
          nativeId: created.id,
        }))!;
        thread = (await store.getThread(thread.id))!;
        await continuePhases(receipt, thread);
      } else if (requestId.endsWith(':resume')) {
        if (!nativeId) conflict();
        own(thread.provider, nativeId);
        const resumed =
          thread.provider === 'codex'
            ? await native.resumeThread(requestId, nativeId)
            : await claude.resumeThread(requestId, nativeId, thread.workspaceRoot, thread.name);
        if ((await resolveWorkspaceTarget(resumed.cwd, roots)) !== thread.workspaceRoot)
          agentUnavailable();
        await apply({
          kind: 'resumed',
          actionId: receipt.id,
          requestId,
          nativeState: resumed.status.type,
        });
      } else if (requestId.endsWith(':name')) {
        if (!nativeId || command.kind !== 'thread-rename') conflict();
        await control.nameThread(requestId, nativeId, command.name);
        await apply({ kind: 'renamed', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':turn')) {
        if (!nativeId || !input) conflict();
        const turn =
          thread.provider === 'codex'
            ? await native.startTurn(requestId, nativeId, input.text, input.skill)
            : await claude.startTurn(requestId, nativeId, input.text);
        await apply({
          kind: 'turn-accepted',
          actionId: receipt.id,
          requestId,
          nativeTurnId: turn.id,
        });
      } else if (requestId.endsWith(':steer')) {
        if (!nativeId || command.kind !== 'steer') conflict();
        const nativeTurnId = await native.steer(
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
        if (thread.provider === 'codex') await native.cleanTerminals(requestId, nativeId);
        else await claude.stopSession(requestId, nativeId);
        receipt = (await apply({ kind: 'cleaned', actionId: receipt.id, requestId }))!;
        await continuePhases(receipt, thread);
      } else if (command.kind === 'native-reply') {
        await prompt!.native.reply(reply);
        await apply({ kind: 'reply-written', actionId: receipt.id, requestId });
      }
    } catch (error) {
      // Only a matching native error response proves rejection. Transport loss and malformed results remain uncertain.
      const explicit = isException(error) && NativeRejectionSchema.safeParse(error.data).success;
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
    if (result.canDispatchQueued && result.thread) advanceQueue(result.thread.id);
  };

  native.setEvents({
    notify(method, params) {
      if (method === 'turn/started' || method === 'turn/completed') {
        const { threadId, turn } = parseNative(
          z.object({ threadId: z.string().min(1).max(4096), turn: NativeTurnSchema }),
          params,
        );
        if (!controlled.has(key('codex', threadId))) return;
        if (method === 'turn/started')
          enqueue(() =>
            observe({
              kind: 'turn-started',
              provider: 'codex',
              nativeThreadId: threadId,
              nativeTurnId: turn.id,
            }),
          );
        else if (turn.status !== 'inProgress') {
          const state = turn.status;
          live.completeTurn(key('codex', threadId), turn.id);
          enqueue(() =>
            observe({
              kind: 'turn-completed',
              provider: 'codex',
              nativeThreadId: threadId,
              nativeTurnId: turn.id,
              state,
            }),
          );
        } else agentUnavailable();
      } else if (method === 'item/started' || method === 'item/completed') {
        const { threadId, turnId, item } = parseNative(
          TargetSchema.extend({ item: NativeItemSchema.shape.item }),
          params,
        );
        if (!controlled.has(key('codex', threadId))) return;
        live.put(
          key('codex', threadId),
          toHistoryItem({ turnId, item }),
          method === 'item/completed',
        );
        enqueue(() =>
          observe({
            kind: method === 'item/started' ? 'item-started' : 'item-completed',
            provider: 'codex',
            nativeThreadId: threadId,
            nativeTurnId: turnId,
            nativeItemId: item.id,
          }),
        );
      } else if (
        method === 'item/agentMessage/delta' ||
        method === 'item/commandExecution/outputDelta'
      ) {
        const result = parseNative(DeltaSchema, params);
        if (controlled.has(key('codex', result.threadId)))
          live.append(key('codex', result.threadId), result.turnId, result.itemId, result.delta);
      } else if (method === 'serverRequest/resolved') {
        const { threadId, requestId } = parseNative(
          z.object({
            threadId: z.string().min(1).max(4096),
            requestId: z.union([z.string().max(4096), z.number().int()]),
          }),
          params,
        );
        if (!controlled.has(key('codex', threadId))) return;
        enqueue(async () => {
          await observe({
            kind: 'request-resolved',
            provider: 'codex',
            nativeThreadId: threadId,
            requestId: JSON.stringify(requestId),
          });
          for (const [id, prompt] of prompts)
            if (
              prompt.native.requestId === JSON.stringify(requestId) &&
              prompt.native.provider === 'codex' &&
              prompt.native.nativeThreadId === threadId
            )
              prompts.delete(id);
        });
      }
    },
    request(id, method, params) {
      const prompt = parseCodexPrompt(method, params);
      if (
        !prompt ||
        !controlled.has(key('codex', prompt.params.threadId)) ||
        prompts.size >= 32 ||
        closing
      ) {
        runNativeOwned('codex', undefined, () => native.reject(id));
        return;
      }
      enqueue(async () => {
        const recorded = await store.openApproval({
          id: randomUUID(),
          provider: 'codex',
          nativeThreadId: prompt.params.threadId,
          nativeTurnId: prompt.params.turnId,
          requestId: JSON.stringify(id),
          kind: prompt.kind,
          isBlocking: prompt.kind === 'question' ? prompt.params.isBlocking : true,
          digest: createHmac('sha256', actionKey)
            .update(JSON.stringify([method, params]))
            .digest('hex'),
        });
        if (!recorded) {
          await native.reject(id);
          return;
        }
        if (prompts.has(recorded.id)) return;
        prompts.set(recorded.id, {
          native: {
            provider: 'codex',
            nativeThreadId: prompt.params.threadId,
            nativeTurnId: prompt.params.turnId,
            requestId: JSON.stringify(id),
            fingerprint: JSON.stringify([method, params]),
            presentation: toApprovalPresentation(prompt),
            validate: (response) => buildCodexReply(prompt, response),
            reply: (result) => native.reply(id, result),
            reject: () => native.reject(id),
          },
          presentation: {
            id: recorded.id,
            threadId: recorded.thread.id,
            nativeTurnId: prompt.params.turnId,
            runtimeEpoch: epoch,
            state: 'pending',
            replyActionId: null,
            ...toApprovalPresentation(prompt),
          },
        });
      });
    },
    lateResponse(requestId, result, error) {
      if (!PhaseIdSchema.safeParse(requestId).success || closing) return;
      runNativeOwned('codex', undefined, async () => {
        const actionId = requestId.slice(0, 36);
        const receipt = await store.getAction(actionId);
        if (
          !receipt ||
          receipt.runtimeEpoch !== epoch ||
          receipt.nativeRequestId !== requestId ||
          !['submitted', 'uncertain'].includes(receipt.delivery) ||
          !receipt.threadId
        )
          return;
        const thread = await store.getThread(receipt.threadId);
        if (!thread || thread.provider !== 'codex') return;
        let outcome: INativeOutcome;
        if (error !== undefined)
          outcome = { kind: 'failed', actionId, requestId, failure: 'agent-unavailable' };
        else if (requestId.endsWith(':create')) {
          const created = z.object({ thread: NativeThreadSchema }).parse(result).thread;
          if ((await resolveWorkspaceTarget(created.cwd, roots)) !== thread.workspaceRoot)
            agentUnavailable();
          own('codex', created.id);
          outcome = { kind: 'created', actionId, requestId, nativeId: created.id };
        } else if (requestId.endsWith(':resume')) {
          const resumed = z.object({ thread: NativeThreadSchema }).parse(result).thread;
          if (
            resumed.id !== thread.nativeId ||
            (await resolveWorkspaceTarget(resumed.cwd, roots)) !== thread.workspaceRoot
          )
            agentUnavailable();
          outcome = { kind: 'resumed', actionId, requestId, nativeState: resumed.status.type };
        } else if (requestId.endsWith(':turn'))
          outcome = {
            kind: 'turn-accepted',
            actionId,
            requestId,
            nativeTurnId: z.object({ turn: NativeTurnSchema }).parse(result).turn.id,
          };
        else if (requestId.endsWith(':steer'))
          outcome = {
            kind: 'steer-accepted',
            actionId,
            requestId,
            nativeTurnId: z.object({ turnId: z.string() }).parse(result).turnId,
          };
        else if (requestId.endsWith(':name')) {
          z.object({}).parse(result);
          outcome = { kind: 'renamed', actionId, requestId };
        } else if (requestId.endsWith(':interrupt')) {
          z.object({}).parse(result);
          outcome = { kind: 'interrupt-accepted', actionId, requestId };
        } else if (requestId.endsWith(':clean')) {
          z.object({}).parse(result);
          outcome = { kind: 'cleaned', actionId, requestId };
        } else {
          const parsed = z
            .object({ status: z.enum(['unsubscribed', 'notSubscribed', 'notLoaded']) })
            .parse(result);
          void parsed;
          outcome = { kind: 'closed', actionId, requestId };
        }
        const updated = await apply(outcome);
        if (updated && (outcome.kind === 'created' || outcome.kind === 'cleaned'))
          await continuePhases(updated, (await store.getThread(thread.id))!);
      });
    },
    unavailable() {
      if (closing || unavailable) return;
      enqueue(async () => {
        await store.observe({ kind: 'native-unavailable', provider: 'codex' });
        for (const [id, prompt] of prompts)
          if (prompt.native.provider === 'codex') prompts.delete(id);
      });
    },
  });

  claude.setEvents({
    observe(observation) {
      if (
        !('nativeThreadId' in observation) ||
        !observation.nativeThreadId ||
        !controlled.has(key('claude', observation.nativeThreadId))
      )
        return;
      if (observation.kind === 'turn-completed')
        live.completeTurn(key('claude', observation.nativeThreadId), observation.nativeTurnId);
      enqueue(() => observe(observation));
    },
    item(nativeId, item, isComplete, replacedIds) {
      if (!controlled.has(key('claude', nativeId))) return;
      for (const replacedId of replacedIds ?? [])
        live.replace(key('claude', nativeId), item.turnId, replacedId);
      live.put(key('claude', nativeId), item, isComplete);
      enqueue(() =>
        observe({
          kind: isComplete ? 'item-completed' : 'item-started',
          provider: 'claude',
          nativeThreadId: nativeId,
          nativeTurnId: item.turnId,
          nativeItemId: item.nativeId,
        }),
      );
    },
    gap(nativeId) {
      live.markGap(key('claude', nativeId));
    },
    delta(nativeId, turnId, itemId, text) {
      if (controlled.has(key('claude', nativeId)))
        live.append(key('claude', nativeId), turnId, itemId, text);
    },
    prompt(prompt) {
      if (!controlled.has(key('claude', prompt.nativeThreadId)) || prompts.size >= 32 || closing) {
        runNativeOwned('claude', prompt.nativeThreadId, prompt.reject);
        return;
      }
      enqueue(async () => {
        const recorded = await store.openApproval({
          id: randomUUID(),
          provider: 'claude',
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
          presentation: {
            id: recorded.id,
            threadId: recorded.thread.id,
            nativeTurnId: prompt.nativeTurnId,
            runtimeEpoch: epoch,
            state: 'pending',
            replyActionId: null,
            ...prompt.presentation,
          },
        });
      });
    },
    outcome(outcome) {
      enqueue(async () => {
        await apply(outcome);
      });
    },
    unavailable(nativeId) {
      if (closing) return;
      enqueue(async () => {
        await store.observe({
          kind: 'native-unavailable',
          provider: 'claude',
          nativeThreadId: nativeId,
        });
        for (const [id, prompt] of prompts)
          if (prompt.native.provider === 'claude' && prompt.native.nativeThreadId === nativeId)
            prompts.delete(id);
      });
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
    let provider: IManagedThread['provider'] = 'provider' in command ? command.provider : 'codex';
    const prepared: {
      workspaceRoot?: string;
      nativeId?: string;
      text?: string;
      skill?: INativeSkillInput | null;
    } = {};
    let input: { text: string; skill: INativeSkillInput | null } | undefined;
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
    if (!(provider === 'codex' ? native : claude).isAvailable) agentUnavailable();
    if (command.kind === 'steer' && provider === 'claude') conflict();
    if (command.kind === 'thread-create' || command.kind === 'thread-adopt')
      prepared.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    if (command.kind === 'thread-adopt') {
      const target =
        provider === 'codex'
          ? await native.readThread(command.nativeId)
          : await readClaudeThread(command.nativeId, prepared.workspaceRoot!);
      if (
        (provider === 'codex'
          ? target.nativeState !== 'notLoaded'
          : target.historyState !== 'available') ||
        (await resolveWorkspaceTarget(target.workspaceRoot, roots)) !== prepared.workspaceRoot
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
      if (nativeId) {
        const target =
          provider === 'codex'
            ? await native.readThread(nativeId)
            : await readClaudeThread(nativeId, thread.workspaceRoot);
        // native unsubscribe may retain an idle thread after its managed control is closed
        const canResume =
          provider === 'codex'
            ? target.nativeState === 'notLoaded' ||
              (command.kind === 'thread-resume' &&
                thread.state === 'inactive' &&
                thread.ownership === 'managed' &&
                target.nativeState === 'idle')
            : target.historyState === 'available';
        if (
          !canResume ||
          (await resolveWorkspaceTarget(target.workspaceRoot, roots)) !== thread.workspaceRoot
        )
          conflict();
        prepared.nativeId = nativeId;
      }
    } else if (command.kind === 'native-reply') {
      const prompt = prompts.get(command.approvalId);
      if (
        !prompt ||
        prompt.presentation.threadId !== command.threadId ||
        prompt.presentation.nativeTurnId !== command.expectedTurnId
      )
        conflict();
      prompt.native.validate(command.response);
    }
    if (command.kind === 'message' || command.kind === 'queue') {
      input = await skills.prepare(command.threadId, command.input);
      prepared.text = input.text;
      prepared.skill = input.skill;
    }
    const admitted = await plans.admitNative(action, prepared);
    if (
      admitted.isNew &&
      admitted.receipt.delivery === 'submitted' &&
      command.kind === 'native-reply'
    ) {
      const prompt = prompts.get(command.approvalId);
      if (prompt) prompt.presentation.replyActionId = admitted.receipt.id;
    }
    if (admitted.isNew && admitted.dispatchActionId && admitted.thread) {
      const receipt =
        admitted.dispatchActionId === admitted.receipt.id
          ? admitted.receipt
          : await store.getAction(admitted.dispatchActionId);
      if (!receipt) conflict();
      let dispatchedCommand = command;
      if (command.kind === 'queue-send') {
        if (!receipt.queuedText) conflict();
        dispatchedCommand = {
          kind: 'message',
          threadId: admitted.thread.id,
          input: { kind: 'text', text: receipt.queuedText },
        };
        input = { text: receipt.queuedText, skill: receipt.queuedSkill };
      }
      runOwned(
        () => dispatch(receipt, admitted.thread!, dispatchedCommand, input),
        admitted.thread.id,
      );
    }
    return admitted.receipt;
  };

  /** Waits for actual native lifecycle evidence, never an interrupt acknowledgement. */
  const waitForThread = async (
    id: string,
    predicate: (thread: IManagedThread) => boolean,
  ): Promise<IManagedThread> => {
    const deadline = Date.now() + 30_000;
    while (true) {
      const thread = await store.getThread(id);
      if (!thread) conflict();
      if (predicate(thread!)) return thread!;
      if (
        thread!.ownership === 'uncertain' ||
        thread!.state === 'unknown' ||
        Date.now() >= deadline
      )
        conflict();
      await wait(250);
    }
  };
  /** Stops only one phase-bound controller and confirms its native background cleanup. */
  const quiesceThread = async (
    control: IPlanRevisionWorkflow['controls'][number],
  ): Promise<void> => {
    await Promise.allSettled([...admissions]);
    await Promise.allSettled(
      [...tasks].filter((task) => taskOwners.get(task) === control.threadId),
    );
    await lane;
    let thread = await store.getThread(control.threadId);
    if (!thread) conflict();
    await validateRoot(thread!);
    if (
      thread!.ownership === 'managed' &&
      thread!.state === 'inactive' &&
      thread!.runtimeEpoch === null
    )
      return;
    if (
      thread!.ownership !== 'managed' ||
      thread!.runtimeEpoch !== epoch ||
      !thread!.nativeId ||
      !controlled.has(key(thread!.provider, thread!.nativeId!))
    )
      conflict();
    if (thread!.activeTurnId) {
      const prior = await store.getAction(control.interruptActionId);
      const expectedTurnId = prior?.nativeTurnId ?? thread!.activeTurnId!;
      const receipt = await admitAndDispatch({
        id: control.interruptActionId,
        runtimeEpoch: epoch,
        command: { kind: 'interrupt', threadId: control.threadId, expectedTurnId },
      });
      if (receipt.delivery === 'failed') conflict();
      thread = await waitForThread(
        control.threadId,
        (current) =>
          current.activeTurnId === null &&
          !['starting', 'running', 'waiting-input', 'waiting-approval', 'stopping'].includes(
            current.state,
          ),
      );
    }
    const receipt = await admitAndDispatch({
      id: control.closeActionId,
      runtimeEpoch: epoch,
      command: { kind: 'thread-close', threadId: control.threadId },
    });
    if (receipt.delivery === 'failed') conflict();
    await waitForThread(
      control.threadId,
      (current) =>
        current.state === 'inactive' &&
        current.runtimeEpoch === null &&
        current.ownership === 'managed',
    );
  };

  return {
    live,
    /**
     * Returns after durable admission; the native operation outlives this client request.
     * @returns The durable admission receipt after validation.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
     * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
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
    /** Reads only current in-memory prompts for the selected managed thread. */
    approvals(threadId: string): INativeApproval[] {
      return [...prompts.values()]
        .filter((prompt) => prompt.presentation.threadId === threadId)
        .map((prompt) => structuredClone(prompt.presentation));
    },
    /**
     * Quiesces the selected managed cohort without stopping unrelated controllers.
     * @returns A promise resolved only after interruption, background cleanup and release evidence.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     */
    async quiescePlan(controls: IPlanRevisionWorkflow['controls']): Promise<void> {
      const failures: unknown[] = [];
      for (let index = 0; index < controls.length; index += 4) {
        const results = await Promise.allSettled(
          controls.slice(index, index + 4).map(quiesceThread),
        );
        for (const result of results)
          if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length) throw failures[0];
    },
    /**
     * Stops admission, interrupts active work, cleans native terminals and confirms shutdown.
     * @returns A promise resolved after native exit and release of durable control ownership.
     * @throws
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
            const control = provider === 'codex' ? native : claude;
            const thread = await store.getThreadByNativeId(provider, nativeId);
            if (control.isAvailable && thread?.activeTurnId) {
              try {
                await control.interrupt(`${randomUUID()}:shutdown`, nativeId, thread.activeTurnId);
              } catch {
                /* native process termination below remains mandatory */
              }
            }
          }),
        );
        await Promise.allSettled([...tasks]);
        await lane.catch(() => undefined);
        if (native.isAvailable)
          for (const { provider, nativeId } of controlled.values()) {
            if (provider !== 'codex') continue;
            await native.cleanTerminals(`${randomUUID()}:shutdown-clean`, nativeId);
            await native.verifyTerminalsClosed(nativeId);
          }
      } catch (error) {
        cleanupFailure = error;
      } finally {
        const nativeExit = await Promise.allSettled([native.close(), claude.close()]);
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
