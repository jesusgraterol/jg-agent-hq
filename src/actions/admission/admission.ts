import type {
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  IPreparedInput,
} from '../../contracts/index.js';
import { readInputFiles } from '../../providers/index.js';
import { capabilityUnavailable } from '../../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import type { IAdmission } from '../../store/control/index.js';

import type { createDispatch } from '../dispatch/index.js';
import type { IActionsContext } from '../types.js';
import { agentUnavailable, conflict } from '../utilities.js';

/**
 * Validates submitted actions against their current targets and admits each one once.
 * @returns The admission that hands new actions to dispatch.
 */
export const createAdmission = (
  context: IActionsContext,
  dispatcher: ReturnType<typeof createDispatch>,
) => {
  const { registry, store, roots, skills, claudeTerminalOf, state, prompts, waits } = context;
  const { validateRoot, dispatch } = dispatcher;

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
    const existing = await store.call('reads', 'getAction', action.id);
    if (existing) {
      if (existing.threadId) {
        const thread = await store.call('reads', 'getThread', existing.threadId);
        if (thread) await validateRoot(thread);
      }
      return (await store.call('admission', 'admit', { action, prepared: {} })).receipt;
    }
    if (state.isClosing || state.isUnavailable || state.ownedCount >= 64) agentUnavailable();
    const command = action.command;
    let provider: IManagedThread['provider'] | undefined =
      'provider' in command ? command.provider : undefined;
    const prepared: IAdmission['prepared'] = {};
    let input: IPreparedInput | undefined;
    if ('threadId' in command) {
      const target = await store.call('reads', 'getThread', command.threadId);
      if (target) {
        await validateRoot(target);
        provider = target.provider;
      }
    } else if ('queuedActionId' in command) {
      const queued = await store.call('reads', 'getAction', command.queuedActionId);
      const target = queued?.threadId
        ? await store.call('reads', 'getThread', queued.threadId)
        : null;
      if (target) {
        await validateRoot(target);
        provider = target.provider;
      }
    }
    if (!provider) return (await store.call('admission', 'admit', { action, prepared })).receipt;
    const control = await registry.get(provider);
    if (!control.isAvailable) agentUnavailable();
    if (command.kind === 'steer') {
      const capabilities = await control.readCapabilities(
        (await store.call('reads', 'getThread', command.threadId))?.nativeId ?? undefined,
      );
      if (capabilities.operations.steer.state !== 'supported') capabilityUnavailable();
    }
    if (command.kind === 'thread-create' || command.kind === 'thread-adopt')
      prepared.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
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
      const thread = await store.call('reads', 'getThread', command.threadId);
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
      const thread = await store.call('reads', 'getThread', command.threadId);
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
    const admitted = await store.call('admission', 'admit', { action, prepared });
    // sending or canceling a queued entry changes that entry's own receipt
    if (admitted.isNew && 'queuedActionId' in command) waits.notifyAction(command.queuedActionId);
    if (admitted.isNew && admitted.dispatchActionId && admitted.thread) {
      const receipt =
        admitted.dispatchActionId === admitted.receipt.id
          ? admitted.receipt
          : await store.call('reads', 'getAction', admitted.dispatchActionId);
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
      context.runOwned(() => dispatch(receipt, admitted.thread!, dispatchedCommand, input));
    }
    return admitted.receipt;
  };

  return { admitAndDispatch };
};
