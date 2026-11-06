import { z } from 'zod';

import type {
  IActionCommand,
  IActionEnvelope,
  IActionReceipt,
  IManagedThread,
  IMessageInput,
  IPreparedInput,
} from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';
import { PROVIDER_OPERATIONS, readInputFiles } from '../../providers/index.js';
import { capabilityUnavailable, type IBoundAgentProvider } from '../../providers/registry/index.js';
import { resolveWorkspaceDirectory, resolveWorkspaceTarget } from '../../runtime/state/index.js';
import type { IAdmission } from '../../store/control/index.js';

import type { createDispatch } from '../dispatch/index.js';
import type { IActionsContext } from '../types.js';
import { agentUnavailable, conflict } from '../utilities.js';

// the managed thread states a close accepts while no turn runs, which a deletion closes from
const CLOSABLE_STATES: ReadonlySet<IManagedThread['state']> = new Set([
  'idle',
  'completed',
  'failed',
  'interrupted',
]);
// the live states of a session a process holds, which a deletion refuses
const HELD_STATES: ReadonlySet<string> = new Set(['running', 'waiting', 'idle']);

/**
 * Validates submitted actions against their current targets and admits each one once.
 * @returns The admission that hands new actions to dispatch.
 */
export const createAdmission = (
  context: IActionsContext,
  dispatcher: ReturnType<typeof createDispatch>,
) => {
  const { registry, store, roots, epoch, skills, claudeTerminalOf, state, prompts, waits } =
    context;
  const { validateRoot, dispatch } = dispatcher;

  /**
   * Prepares a message's input: its files, read and bound to their content, and its exact text,
   * with a skill resolved from the target's catalog.
   * @returns The input as dispatch sends it, with the turn settings it carries.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const prepareInput = async (
    input: IMessageInput,
    settings: IPreparedInput['settings'],
    workspaceRoot: string,
    target: Parameters<typeof skills.prepare>[0],
  ): Promise<IPreparedInput> => {
    const files = await readInputFiles(input.files ?? [], workspaceRoot, roots);
    return {
      ...(await skills.prepare(target, input)),
      files: files.map(({ content: _content, ...reference }) => reference),
      settings,
    };
  };

  /**
   * Refuses the deletion of a session a process may still run: one running, waiting or held by a
   * client, one a terminal runs, a managed session neither closed nor idle under this runtime, and
   * one recorded in another folder, and a Claude session ID that isn't a UUID. Codex reads a
   * session HQ doesn't manage, which checks its folder.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const checkDeletion = async (
    command: Extract<IActionCommand, { kind: 'thread-delete' }>,
    workspaceRoot: string,
    control: IBoundAgentProvider,
  ): Promise<void> => {
    const refuse = (): never => {
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    };
    const { provider, nativeId } = command;
    const thread = await store.call('reads', 'getThreadByNativeId', provider, nativeId);
    const isControlled = thread?.runtimeEpoch === epoch;
    if (
      thread &&
      (thread.workspaceRoot !== workspaceRoot ||
        (isControlled
          ? thread.activeTurnId !== null || !CLOSABLE_STATES.has(thread.state)
          : thread.state !== 'inactive'))
    )
      refuse();
    // a Claude session's ID names its files, so it must be the UUID Claude gives it
    if (
      provider === 'claude' &&
      (!z.uuid().safeParse(nativeId).success || claudeTerminalOf(nativeId))
    )
      refuse();
    if (isControlled) return;
    const [observed] = await store.call('sessions', 'states', provider, [nativeId]);
    if (observed && HELD_STATES.has(observed.state)) refuse();
    if (!thread && provider === 'codex') {
      const target = await control.inspectThread(nativeId, workspaceRoot);
      if (target.thread.nativeState !== 'notLoaded') refuse();
    }
  };

  /**
   * Validates the current target and separates new dispatch from idempotent receipt reads. A
   * deletion runs within the request, which returns its settled receipt or throws its failure.
   * @returns The durable admission receipt; other native work runs independently.
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
    // operation support never changes while a provider runs, so it is read without the native CLI
    if (command.kind === 'steer' && PROVIDER_OPERATIONS[provider].steer.state !== 'supported')
      capabilityUnavailable();
    if (
      command.kind === 'thread-create' ||
      command.kind === 'thread-adopt' ||
      command.kind === 'thread-delete'
    )
      prepared.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    if (command.kind === 'thread-create' && command.input) {
      // a first input resolves a skill from the folder's catalog, as the new session's matches it
      input = await prepareInput(command.input, {}, prepared.workspaceRoot!, {
        provider: command.provider,
        workspaceRoot: prepared.workspaceRoot!,
      });
      await control.validateInput(undefined, input);
      prepared.input = input;
    } else if (command.kind === 'thread-delete') {
      await checkDeletion(command, prepared.workspaceRoot!, control);
      prepared.nativeId = command.nativeId;
    } else if (command.kind === 'thread-adopt') {
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
      let workspaceRoot = thread.workspaceRoot;
      if (command.workspaceChange) {
        if (
          !control.changeWorkspace ||
          PROVIDER_OPERATIONS[provider].workspaceChange.state !== 'supported'
        )
          capabilityUnavailable();
        const source = await resolveWorkspaceTarget(
          command.workspaceChange.expectedWorkspaceRoot,
          roots,
        );
        workspaceRoot = await resolveWorkspaceDirectory(
          command.workspaceChange.workspaceRoot,
          roots,
        );
        if (
          source !== thread.workspaceRoot ||
          source !== command.workspaceChange.expectedWorkspaceRoot ||
          workspaceRoot !== command.workspaceChange.workspaceRoot
        )
          conflict();
      }
      input = await prepareInput(
        command.input,
        command.settings ?? {},
        workspaceRoot,
        command.workspaceChange ? { provider, workspaceRoot } : { threadId: command.threadId },
      );
      if (command.workspaceChange) input.workspaceChange = command.workspaceChange;
      await control.validateInput(thread.nativeId, input);
      prepared.input = input;
    }
    const admitted = await store.call('admission', 'admit', { action, prepared });
    // sending or canceling a queued entry changes that entry's own receipt
    if (admitted.isNew && 'queuedActionId' in command) waits.notifyAction(command.queuedActionId);
    // a deletion of a session HQ doesn't manage has no thread to dispatch on
    if (
      admitted.isNew &&
      admitted.dispatchActionId &&
      (admitted.thread || command.kind === 'thread-delete')
    ) {
      const receipt =
        admitted.dispatchActionId === admitted.receipt.id
          ? admitted.receipt
          : await store.call('reads', 'getAction', admitted.dispatchActionId);
      if (!receipt) conflict();
      if (command.kind === 'thread-delete') {
        const failure = await dispatch(receipt, admitted.thread, command);
        if (failure !== undefined) throw failure;
        return (await store.call('reads', 'getAction', receipt.id)) ?? conflict();
      }
      const { thread } = admitted;
      if (!thread) conflict();
      let dispatchedCommand = command;
      if (command.kind === 'queue-send') {
        if (!receipt.queuedInput) conflict();
        dispatchedCommand = {
          kind: 'message',
          threadId: thread.id,
          input: { kind: 'text', text: receipt.queuedInput.text },
          settings: receipt.queuedInput.settings,
          ...(receipt.queuedInput.workspaceChange
            ? { workspaceChange: receipt.queuedInput.workspaceChange }
            : {}),
        };
        input = receipt.queuedInput;
      }
      context.runOwned(async () => {
        await dispatch(receipt, thread, dispatchedCommand, input);
      });
    }
    return admitted.receipt;
  };

  return { admitAndDispatch };
};
