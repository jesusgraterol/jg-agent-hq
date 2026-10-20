import { createHmac, randomUUID } from 'node:crypto';
import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  INativeApproval,
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
  type ICodexPrompt,
  type ICodexProvider,
} from '../providers/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';
import type { INativeOutcome, INativeObservation } from '../store/control/index.js';

import { LiveItems } from './live/index.js';

const TargetSchema = z.object({
  threadId: z.string().min(1).max(4096),
  turnId: z.string().min(1).max(4096),
});
const DeltaSchema = TargetSchema.extend({ itemId: z.string().min(1).max(4096), delta: z.string() });
const NativeErrorSchema = z.object({ nativeCode: z.number() });
const PhaseIdSchema = z
  .string()
  .regex(/^[a-f0-9-]{36}:(create|resume|name|turn|steer|interrupt|clean|close)$/);

/**
 * Owns admitted native work across client disconnects, with durable delivery evidence.
 * @returns The runtime-scoped action controller. Close must precede worker shutdown.
 */
export const createActions = (
  native: ICodexProvider,
  store: IStore,
  roots: string[],
  epoch: string,
  actionKey: Uint8Array,
) => {
  const prompts = new Map<
    string,
    { id: string | number; native: ICodexPrompt; presentation: INativeApproval }
  >();
  const controlled = new Set<string>();
  const live = new LiveItems();
  const tasks = new Set<Promise<void>>();
  const admissions = new Set<Promise<IActionReceipt>>();
  let lane = Promise.resolve();
  let eventCount = 0;
  let closing = false;
  let unavailable = false;
  let eventFailure: unknown;

  const conflict: () => never = () => {
    throw new Exception('The HQ action conflicts with its recorded state', undefined, {
      kind: 'state-conflict',
    });
  };
  const agentUnavailable: () => never = () => {
    throw new Exception('The Codex integration failed', undefined, { kind: 'agent-unavailable' });
  };

  /** Quarantines controls after a lifecycle gap and stops the native transport. */
  const failEvents = (cause?: unknown): void => {
    if (unavailable) return;
    unavailable = true;
    eventFailure = cause;
    prompts.clear();
    const previous = lane;
    lane = (async () => {
      await previous.catch(() => undefined);
      await store.observe({ kind: 'native-unavailable' });
    })();
    void lane.catch((error: unknown) => {
      eventFailure = error;
    });
    void native.close().catch((error: unknown) => {
      eventFailure = error;
    });
  };

  /** Keeps native work owned by the runtime when a requesting client disconnects. */
  const runOwned = (operation: () => Promise<void>): void => {
    const task = (async () => {
      try {
        await operation();
      } catch (error) {
        failEvents(error);
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(failEvents);
  };
  /** Orders lifecycle persistence without buffering an unbounded stream. */
  const enqueue = (operation: () => Promise<void>): void => {
    if (unavailable) return;
    if (eventCount >= 128) {
      failEvents(
        new Exception('The Codex integration failed', undefined, { kind: 'agent-unavailable' }),
      );
      return;
    }
    eventCount += 1;
    const previous = lane;
    lane = (async () => {
      try {
        await previous;
        await operation();
      } finally {
        eventCount -= 1;
      }
    })();
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
      const next = await store.claimQueued(threadId);
      if (next)
        await dispatch(next.receipt, next.thread, { kind: 'message', threadId, text: next.text });
    });
  };

  const apply = async (outcome: INativeOutcome): Promise<IActionReceipt | null> => {
    const receipt = await store.applyOutcome(outcome);
    if (!receipt?.threadId) return receipt;
    const thread = await store.getThread(receipt.threadId);
    if (thread?.nativeId && outcome.kind === 'closed') {
      controlled.delete(thread.nativeId);
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
      await native.nameThread(requestId, thread.nativeId, admissionName);
      await apply({ kind: 'renamed', actionId: receipt.id, requestId });
    } else if (requestId.endsWith(':close')) {
      await native.verifyTerminalsClosed(thread.nativeId);
      await native.unsubscribe(requestId, thread.nativeId);
      await apply({ kind: 'closed', actionId: receipt.id, requestId });
    }
  };

  /**
   * Dispatches one admitted intent once and records delivery without replaying it.
   * @returns A promise resolved after delivery evidence or uncertainty is persisted.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   * - -1: The HQ store failed
   */
  const dispatch = async (
    initial: IActionReceipt,
    originalThread: IManagedThread,
    command: IActionEnvelope['command'],
  ): Promise<void> => {
    let receipt = initial;
    let thread = originalThread;
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
        command.kind === 'native-reply'
          ? buildCodexReply(prompt!.native, command.response)
          : undefined;
      hasDispatched = true;
      if (requestId.endsWith(':create')) {
        const created = await native.startThread(requestId, thread.workspaceRoot);
        // bind the exact response before attempting the second, independently receipted native phase
        controlled.add(created.id);
        live.open(created.id);
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
        controlled.add(nativeId);
        live.open(nativeId);
        const resumed = await native.resumeThread(requestId, nativeId);
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
        await native.nameThread(requestId, nativeId, command.name);
        await apply({ kind: 'renamed', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':turn')) {
        if (!nativeId || !('text' in command)) conflict();
        const turn = await native.startTurn(requestId, nativeId, command.text);
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
        await native.interrupt(requestId, nativeId, command.expectedTurnId);
        await apply({ kind: 'interrupt-accepted', actionId: receipt.id, requestId });
      } else if (requestId.endsWith(':clean')) {
        if (!nativeId) conflict();
        await native.cleanTerminals(requestId, nativeId);
        receipt = (await apply({ kind: 'cleaned', actionId: receipt.id, requestId }))!;
        await continuePhases(receipt, thread);
      } else if (command.kind === 'native-reply') {
        await native.reply(prompt!.id, reply);
        await apply({ kind: 'reply-written', actionId: receipt.id, requestId });
      }
    } catch (error) {
      // Only a matching native error response proves rejection. Transport loss and malformed results remain uncertain.
      const explicit =
        error instanceof Exception && NativeErrorSchema.safeParse(error.data).success;
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
          prompt.native.params.threadId === observation.nativeThreadId &&
          prompt.native.params.turnId === observation.nativeTurnId
        )
          prompts.delete(id);
    }
    if (result.canDispatchQueued && result.thread) advanceQueue(result.thread.id);
  };

  native.setEvents({
    notify(method, params) {
      if (method === 'turn/started' || method === 'turn/completed') {
        const { threadId, turn } = parseNative(
          z.object({ threadId: z.string().min(1).max(4096), turn: NativeTurnSchema }),
          params,
        );
        if (!controlled.has(threadId)) return;
        if (method === 'turn/started')
          enqueue(() =>
            observe({ kind: 'turn-started', nativeThreadId: threadId, nativeTurnId: turn.id }),
          );
        else if (turn.status !== 'inProgress') {
          const state = turn.status;
          live.completeTurn(threadId, turn.id);
          enqueue(() =>
            observe({
              kind: 'turn-completed',
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
        if (!controlled.has(threadId)) return;
        live.put(threadId, toHistoryItem({ turnId, item }), method === 'item/completed');
        enqueue(() =>
          observe({
            kind: method === 'item/started' ? 'item-started' : 'item-completed',
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
        if (controlled.has(result.threadId))
          live.append(result.threadId, result.turnId, result.itemId, result.delta);
      } else if (method === 'serverRequest/resolved') {
        const { threadId, requestId } = parseNative(
          z.object({
            threadId: z.string().min(1).max(4096),
            requestId: z.union([z.string().max(4096), z.number().int()]),
          }),
          params,
        );
        if (!controlled.has(threadId)) return;
        enqueue(async () => {
          await observe({
            kind: 'request-resolved',
            nativeThreadId: threadId,
            requestId: JSON.stringify(requestId),
          });
          for (const [id, prompt] of prompts)
            if (prompt.id === requestId && prompt.native.params.threadId === threadId)
              prompts.delete(id);
        });
      }
    },
    request(id, method, params) {
      const prompt = parseCodexPrompt(method, params);
      if (!prompt || !controlled.has(prompt.params.threadId) || prompts.size >= 32 || closing) {
        runOwned(() => native.reject(id));
        return;
      }
      enqueue(async () => {
        const recorded = await store.openApproval({
          id: randomUUID(),
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
          id,
          native: prompt,
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
      runOwned(async () => {
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
        if (!thread) return;
        let outcome: INativeOutcome;
        if (error !== undefined)
          outcome = { kind: 'failed', actionId, requestId, failure: 'agent-unavailable' };
        else if (requestId.endsWith(':create')) {
          const created = z.object({ thread: NativeThreadSchema }).parse(result).thread;
          if ((await resolveWorkspaceTarget(created.cwd, roots)) !== thread.workspaceRoot)
            agentUnavailable();
          controlled.add(created.id);
          live.open(created.id);
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
      failEvents();
    },
  });

  /**
   * Validates the current target and separates new dispatch from idempotent receipt reads.
   * @returns The durable admission receipt; native work runs independently.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   * - -1: The HQ request is invalid
   * - -1: The HQ target is outside the allowed workspaces
   * - -1: The Codex integration failed
   * - -1: The HQ store failed
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
    if (closing || unavailable || !native.isAvailable || tasks.size >= 64) agentUnavailable();
    const command = action.command;
    const prepared: { workspaceRoot?: string; nativeId?: string } = {};
    if ('threadId' in command) {
      const target = await store.getThread(command.threadId);
      if (target) await validateRoot(target);
    } else if ('queuedActionId' in command) {
      const queued = await store.getAction(command.queuedActionId);
      const target = queued?.threadId ? await store.getThread(queued.threadId) : null;
      if (target) await validateRoot(target);
    }
    if (command.kind === 'thread-create' || command.kind === 'thread-adopt')
      prepared.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    if (command.kind === 'thread-adopt') {
      const target = await native.readThread(command.nativeId);
      if (
        target.nativeState !== 'notLoaded' ||
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
        const target = await native.readThread(nativeId);
        if (
          target.nativeState !== 'notLoaded' ||
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
      buildCodexReply(prompt.native, command.response);
    }
    const admitted = await store.admit({ action, prepared });
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
          text: receipt.queuedText,
        };
      }
      runOwned(() => dispatch(receipt, admitted.thread!, dispatchedCommand));
    }
    return admitted.receipt;
  };

  return {
    live,
    /**
     * Returns after durable admission; the native operation outlives this client request.
     * @throws
     * - -1: The HQ action conflicts with its recorded state
     * - -1: The HQ request is invalid
     * - -1: The HQ target is outside the allowed workspaces
     * - -1: The Codex integration failed
     * - -1: The HQ store failed
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
     * Stops admission, interrupts active work, cleans native terminals and confirms shutdown.
     * @returns A promise resolved after native exit and release of durable control ownership.
     * @throws
     * - -1: The Codex integration failed
     * - -1: The HQ transport failed
     * - -1: The HQ store failed
     */
    async close(): Promise<void> {
      closing = true;
      let cleanupFailure: unknown;
      try {
        await Promise.allSettled([...admissions]);
        // Active turn IDs come from ordered native evidence, never from an interrupt acknowledgement.
        for (const nativeId of controlled) {
          const thread = await store.getThreadByNativeId(nativeId);
          if (native.isAvailable && thread?.activeTurnId) {
            try {
              await native.interrupt(`${randomUUID()}:shutdown`, nativeId, thread.activeTurnId);
            } catch {
              /* native process termination below remains mandatory */
            }
          }
        }
        await Promise.allSettled([...tasks]);
        await lane.catch(() => undefined);
        if (native.isAvailable)
          for (const nativeId of controlled) {
            await native.cleanTerminals(`${randomUUID()}:shutdown-clean`, nativeId);
            await native.verifyTerminalsClosed(nativeId);
          }
      } catch (error) {
        cleanupFailure = error;
      } finally {
        const nativeExit = await Promise.allSettled([native.close()]);
        await Promise.allSettled([...tasks]);
        await lane.catch(() => undefined);
        if (nativeExit[0]!.status === 'rejected')
          throw new Exception(
            `The HQ transport failed: ${extractMessage(nativeExit[0]!.reason)}`,
            undefined,
            { kind: 'operation-failed' },
            { cause: cleanupFailure ?? nativeExit[0]!.reason },
          );
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
