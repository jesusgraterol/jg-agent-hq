import { isException } from 'jg-exception';
import { z } from 'zod';

import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  IPreparedInput,
} from '../../contracts/index.js';
import { toActionFailure } from '../../errors/index.js';
import type { IProviderThread } from '../../providers/index.js';
import { retainNativeLineage, readInputFiles, toActionRequestId } from '../../providers/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import type { INativeOutcome } from '../../store/control/index.js';

import type { IActionsContext } from '../types.js';
import { agentUnavailable, conflict } from '../utilities.js';

const NativeRejectionSchema = z.union([
  z.object({ nativeCode: z.number() }),
  z.object({ nativeRejection: z.literal(true) }),
]);

/**
 * Dispatches admitted actions to their native sessions, one phase at a time, and applies each
 * phase's outcome to the action ledger.
 * @returns The dispatch operations the runtime's events, admission and reattachment share.
 */
export const createDispatch = (context: IActionsContext) => {
  const { registry, store, roots, state, controlled, watched, waits } = context;

  const validateRoot = async (thread: IManagedThread): Promise<void> => {
    if ((await resolveWorkspaceTarget(thread.workspaceRoot, roots)) !== thread.workspaceRoot)
      conflict();
  };

  /**
   * Verifies the native workspace and identity before binding them to a managed identity.
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
      const existing = await store.call(
        'reads',
        'getThreadByNativeId',
        thread.provider,
        native.nativeId,
      );
      if (existing && existing.id !== thread.id) agentUnavailable();
      return {
        ...native,
        nativeLineage: retainNativeLineage(thread.nativeLineage, native.nativeLineage),
      };
    } catch (cause) {
      registry.quarantine(thread.provider, cause);
      throw cause;
    }
  };

  /** Lets the worker claim one ready entry atomically without locking a turn’s lifetime. */
  const advanceQueue = (threadId: string, provider: IManagedThread['provider']): void => {
    if (state.isClosing || state.isUnavailable || context.blockedProviders.has(provider)) return;
    context.runOwned(async () => {
      const next = await store.call('admission', 'claimQueued', threadId);
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
    const receipt = await store.call('outcomes', 'applyOutcome', outcome);
    waits.notifyAction(outcome.actionId);
    if (!receipt?.threadId) return receipt;
    const thread = await store.call('reads', 'getThread', receipt.threadId);
    if (thread?.nativeId && outcome.kind === 'closed') {
      controlled.delete(context.key(thread.provider, thread.nativeId));
      watched.delete(context.key(thread.provider, thread.nativeId));
    }
    if (thread?.state === 'completed') advanceQueue(thread.id, thread.provider);
    return receipt;
  };
  /**
   * Applies a turn's acknowledgement after the lifecycle events reported before it, such as a
   * turn the agent started and ended while the input waited, so the ledger sees them in order.
   * @returns The updated receipt.
   */
  const applyAfterEvents = async (outcome: INativeOutcome): Promise<IActionReceipt | null> => {
    await state.lane.catch(() => undefined);
    return apply(outcome);
  };

  // a created session is named next, and a cleaned one closed, each an independently receipted phase
  const continuePhases = async (receipt: IActionReceipt, thread: IManagedThread): Promise<void> => {
    const { phase } = receipt;
    if (!phase || !thread.nativeId || state.isClosing) return;
    const requestId = toActionRequestId(receipt.id, phase);
    if (phase === 'name') {
      const admissionName = receipt.kind === 'thread-rename' ? null : thread.name;
      // rename's new name is retained only by its admitted in-memory command; late name acks need no resend
      if (!admissionName) return;
      await (
        await registry.get(thread.provider)
      ).nameThread(requestId, thread.nativeId, admissionName);
      await apply({ kind: 'renamed', actionId: receipt.id, phase });
    } else if (phase === 'close') {
      await (await registry.get(thread.provider)).releaseThread(requestId, thread.nativeId);
      await apply({ kind: 'closed', actionId: receipt.id, phase });
    }
  };

  /**
   * Dispatches one admitted intent once, in the phase its receipt records, and records delivery
   * without replaying it. The native CLI receives a request ID naming the action and its phase.
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
      if (state.isClosing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          phase: receipt.phase!,
          failure: 'state-conflict',
        });
        return;
      }
      await validateRoot(thread);
      if (state.isClosing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          phase: receipt.phase!,
          failure: 'state-conflict',
        });
        return;
      }
      const { phase } = receipt;
      if (!phase) conflict();
      const requestId = toActionRequestId(receipt.id, phase);
      const nativeId = thread.nativeId;
      const prompt =
        command.kind === 'native-reply' ? context.prompts.get(command.approvalId) : undefined;
      if (command.kind === 'native-reply' && !prompt) conflict();
      const reply =
        command.kind === 'native-reply' ? prompt!.native.validate(command.response) : undefined;
      hasDispatched = true;
      if (phase === 'create') {
        const created = await verifyThread(
          thread,
          await control.startThread(
            requestId,
            thread.workspaceRoot,
            command.kind === 'thread-create' ? (command.settings ?? {}) : {},
          ),
        );
        // bind the exact response before attempting the second, independently receipted native phase
        context.own(thread.provider, created.nativeId);
        receipt = (await apply({
          kind: 'created',
          actionId: receipt.id,
          phase,
          nativeId: created.nativeId,
          nativeLineage: created.nativeLineage,
        }))!;
        thread = (await store.call('reads', 'getThread', thread.id))!;
        await continuePhases(receipt, thread);
      } else if (phase === 'resume') {
        if (!nativeId) conflict();
        context.own(thread.provider, nativeId);
        const resumed = await verifyThread(
          thread,
          await control.resumeThread(
            requestId,
            nativeId,
            thread.workspaceRoot,
            thread.name,
            command.kind === 'thread-resume' || command.kind === 'thread-adopt'
              ? (command.settings ?? {})
              : {},
          ),
        );
        await apply({
          kind: 'resumed',
          actionId: receipt.id,
          phase,
          nativeState: resumed.nativeState,
          nativeLineage: resumed.nativeLineage,
        });
      } else if (phase === 'name') {
        if (!nativeId || command.kind !== 'thread-rename') conflict();
        await control.nameThread(requestId, nativeId, command.name);
        await apply({ kind: 'renamed', actionId: receipt.id, phase });
      } else if (phase === 'turn') {
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
        await applyAfterEvents({
          kind: 'turn-accepted',
          actionId: receipt.id,
          phase,
          nativeTurnId: turn.id,
        });
      } else if (phase === 'steer') {
        if (!nativeId || command.kind !== 'steer') conflict();
        const nativeTurnId = await control.steer(
          requestId,
          nativeId,
          command.expectedTurnId,
          command.text,
        );
        await apply({ kind: 'steer-accepted', actionId: receipt.id, phase, nativeTurnId });
      } else if (phase === 'interrupt') {
        if (!nativeId || command.kind !== 'interrupt') conflict();
        await control.interrupt(requestId, nativeId, command.expectedTurnId);
        await apply({ kind: 'interrupt-accepted', actionId: receipt.id, phase });
      } else if (phase === 'clean') {
        if (!nativeId) conflict();
        await control.cleanThread(requestId, nativeId);
        receipt = (await apply({ kind: 'cleaned', actionId: receipt.id, phase }))!;
        await continuePhases(receipt, thread);
      } else if (phase === 'reply') {
        await prompt!.native.reply(reply);
        await apply({ kind: 'reply-written', actionId: receipt.id, phase });
      }
    } catch (error) {
      // Only a matching native error response proves rejection. Transport loss and malformed results remain uncertain.
      const explicit =
        isException(error) &&
        (NativeRejectionSchema.safeParse(error.data).success ||
          error.code === 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE');
      await apply(
        !hasDispatched || explicit
          ? {
              kind: 'failed',
              actionId: receipt.id,
              phase: receipt.phase!,
              failure: explicit ? 'agent-unavailable' : toActionFailure(error),
            }
          : { kind: 'uncertain', actionId: receipt.id, phase: receipt.phase! },
      );
    }
  };

  return {
    validateRoot,
    verifyThread,
    advanceQueue,
    apply,
    continuePhases,
    dispatch,
  };
};
