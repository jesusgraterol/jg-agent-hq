import { isException } from 'jg-exception';
import { z } from 'zod';

import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  IPreparedInput,
} from '../../contracts/index.js';
import { HQ_ERRORS, toActionFailure } from '../../errors/index.js';
import type { IProviderThread } from '../../providers/index.js';
import { retainNativeLineage, readInputFiles, toActionRequestId } from '../../providers/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import type { INativeOutcome } from '../../store/control/index.js';

import type { IActionsContext } from '../types.js';
import { agentUnavailable, assertKnownTurn, conflict } from '../utilities.js';

import { NEXT_PHASES } from './constants.js';

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
    if (thread?.nativeId && (outcome.kind === 'turn-accepted' || outcome.kind === 'steer-accepted'))
      context.live.invalidateProvenance(context.key(thread.provider, thread.nativeId));
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

  /**
   * Dispatches one admitted intent once, in the phase its receipt records, and records delivery
   * without replaying it, continuing with each next phase its outcome moves it to. The native CLI
   * receives a request ID naming the action and its phase. A deletion that fails is recorded
   * failed, since deleting again is safe: a session already gone counts as deleted.
   * @param initial The receipt, in the phase to dispatch.
   * @param originalThread The action's thread, or null for a deletion of a session HQ doesn't manage.
   * @param command The admitted command, when dispatch starts from admission.
   * @param input The prepared input of a turn, unless the receipt holds it as queued input.
   * @param recoveryTurn The verified current turn for explicit recovery of a loaded Codex session.
   * @returns A promise resolved after delivery evidence or uncertainty is persisted, to the
   * failure it recorded, if any.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const dispatch = async (
    initial: IActionReceipt,
    originalThread: IManagedThread | null,
    command?: IActionEnvelope['command'],
    input?: IPreparedInput,
    recoveryTurn?: Extract<INativeOutcome, { kind: 'resumed' }>['latestTurn'],
  ): Promise<unknown> => {
    let receipt = initial;
    let thread = originalThread;
    let hasDispatched = false;
    try {
      const provider = thread?.provider ?? receipt.provider;
      if (!provider) conflict();
      const control = await registry.get(provider);
      if (state.isClosing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          phase: receipt.phase!,
          failure: 'state-conflict',
        });
        return HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
      }
      if (thread) await validateRoot(thread);
      if (state.isClosing) {
        await apply({
          kind: 'failed',
          actionId: receipt.id,
          phase: receipt.phase!,
          failure: 'state-conflict',
        });
        return HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
      }
      const prompt =
        command?.kind === 'native-reply' ? context.prompts.get(command.approvalId) : undefined;
      if (command?.kind === 'native-reply' && !prompt) conflict();
      const reply =
        command?.kind === 'native-reply' ? prompt!.native.validate(command.response) : undefined;
      for (;;) {
        const { phase } = receipt;
        if (!phase) conflict();
        const requestId = toActionRequestId(receipt.id, phase);
        const nativeId = thread?.nativeId;
        hasDispatched = true;
        let next: IActionReceipt | null;
        if (phase === 'create') {
          if (!thread) conflict();
          const created = await verifyThread(
            thread,
            await control.startThread(
              requestId,
              thread.workspaceRoot,
              command?.kind === 'thread-create' ? (command.settings ?? {}) : {},
            ),
          );
          // bind the exact response before attempting the next, independently receipted phase
          context.own(thread.provider, created.nativeId);
          next = await apply({
            kind: 'created',
            actionId: receipt.id,
            phase,
            nativeId: created.nativeId,
            nativeLineage: created.nativeLineage,
          });
        } else if (phase === 'resume') {
          if (!thread || !nativeId) conflict();
          context.own(thread.provider, nativeId);
          if (recoveryTurn !== undefined) {
            if (!control.reattachThread) conflict();
            // only the verified join may acknowledge this recovery, after its second turn read
            const joined = await control.reattachThread(
              `${receipt.id}:recover`,
              nativeId,
              thread.workspaceRoot,
            );
            assertKnownTurn(joined);
            if (
              joined.thread.nativeId !== nativeId ||
              (joined.latestTurn?.nativeId ?? null) !== (recoveryTurn?.nativeTurnId ?? null) ||
              (recoveryTurn?.state !== 'running' && joined.latestTurn?.state === 'running')
            )
              agentUnavailable();
            const verified = await verifyThread(thread, joined.thread);
            await applyAfterEvents({
              kind: 'resumed',
              actionId: receipt.id,
              phase,
              nativeState: verified.nativeState,
              nativeLineage: verified.nativeLineage,
              latestTurn: joined.latestTurn && {
                nativeTurnId: joined.latestTurn.nativeId,
                state: joined.latestTurn.state,
              },
            });
            return undefined;
          }
          const resumed = await verifyThread(
            thread,
            await control.resumeThread(
              requestId,
              nativeId,
              thread.workspaceRoot,
              thread.name,
              command?.kind === 'thread-resume' || command?.kind === 'thread-adopt'
                ? (command.settings ?? {})
                : {},
            ),
          );
          next = await apply({
            kind: 'resumed',
            actionId: receipt.id,
            phase,
            nativeState: resumed.nativeState,
            nativeLineage: resumed.nativeLineage,
          });
        } else if (phase === 'name') {
          // a creation names its session as admitted; a rename's name is only in its command
          const name =
            receipt.kind !== 'thread-rename'
              ? thread?.name
              : command?.kind === 'thread-rename'
                ? command.name
                : undefined;
          if (!nativeId || !name) conflict();
          await control.nameThread(requestId, nativeId, name);
          next = await apply({ kind: 'renamed', actionId: receipt.id, phase });
        } else if (phase === 'turn') {
          const turnInput = input ?? receipt.queuedInput;
          if (!thread || !nativeId || !turnInput) conflict();
          hasDispatched = false;
          const files = await readInputFiles(turnInput.files, thread.workspaceRoot, roots);
          await control.validateInput(nativeId, turnInput);
          hasDispatched = true;
          const turn = await control.startTurn(
            requestId,
            nativeId,
            turnInput.text,
            turnInput.skill,
            turnInput.settings,
            files,
          );
          next = await applyAfterEvents({
            kind: 'turn-accepted',
            actionId: receipt.id,
            phase,
            nativeTurnId: turn.id,
          });
        } else if (phase === 'steer') {
          if (!nativeId || command?.kind !== 'steer') conflict();
          const nativeTurnId = await control.steer(
            requestId,
            nativeId,
            command.expectedTurnId,
            command.text,
          );
          next = await apply({ kind: 'steer-accepted', actionId: receipt.id, phase, nativeTurnId });
        } else if (phase === 'interrupt') {
          // a close interrupts its session's running turn, which admission recorded
          const turnId =
            command?.kind === 'interrupt' ? command.expectedTurnId : thread?.activeTurnId;
          if (!nativeId || !turnId) conflict();
          await control.interrupt(requestId, nativeId, turnId);
          next = await apply({ kind: 'interrupt-accepted', actionId: receipt.id, phase });
        } else if (phase === 'clean') {
          if (!nativeId) conflict();
          await control.cleanThread(requestId, nativeId);
          next = await apply({ kind: 'cleaned', actionId: receipt.id, phase });
        } else if (phase === 'close') {
          if (!nativeId) conflict();
          await control.releaseThread(requestId, nativeId);
          next = await apply({ kind: 'closed', actionId: receipt.id, phase });
        } else if (phase === 'delete') {
          // a session HQ manages is deleted where its record says; another, where admission checked
          const target = thread ?? (command?.kind === 'thread-delete' ? command : null);
          if (!target?.nativeId) conflict();
          await control.deleteThread(requestId, target.nativeId, target.workspaceRoot);
          next = await apply({
            kind: 'deleted',
            actionId: receipt.id,
            phase,
            nativeId: target.nativeId,
          });
        } else {
          await prompt!.native.reply(reply);
          next = await apply({ kind: 'reply-written', actionId: receipt.id, phase });
        }
        if (
          !next ||
          next.delivery !== 'submitted' ||
          next.phase !== NEXT_PHASES[phase] ||
          state.isClosing
        )
          return undefined;
        receipt = next;
        if (thread) thread = (await store.call('reads', 'getThread', thread.id)) ?? thread;
      }
    } catch (error) {
      if (recoveryTurn !== undefined && thread?.nativeId) {
        await store.call('observations', 'observe', {
          kind: 'native-unavailable',
          provider: thread.provider,
          nativeThreadId: thread.nativeId,
        });
        for (const [id, pending] of context.prompts)
          if (pending.threadId === thread.id) context.prompts.delete(id);
        waits.notifyThread(thread.id);
      }
      // Only a matching native error response proves rejection. Transport loss and malformed results remain uncertain.
      const explicit =
        isException(error) &&
        (NativeRejectionSchema.safeParse(error.data).success ||
          error.code === 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE');
      await apply(
        !hasDispatched || explicit || receipt.phase === 'delete'
          ? {
              kind: 'failed',
              actionId: receipt.id,
              phase: receipt.phase!,
              failure: explicit ? 'agent-unavailable' : toActionFailure(error),
            }
          : { kind: 'uncertain', actionId: receipt.id, phase: receipt.phase! },
      );
      return error;
    }
  };

  return {
    validateRoot,
    verifyThread,
    advanceQueue,
    apply,
    dispatch,
  };
};
