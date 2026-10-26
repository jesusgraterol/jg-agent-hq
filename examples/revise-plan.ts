import { requestAgentHq } from 'jg-agent-hq';
import type {
  IActionEnvelope,
  IPlanActionScope,
  IPlanCommandInput,
  IPlanCheckout,
  IPlanOperatorAction,
  IPlanStatus,
  IPlanTarget,
} from 'jg-agent-hq/contracts';
import { inspectPlan } from 'jg-plans';
import { waitUntil } from 'jg-utilities';

/**
 * Revises a selected sequence through native skills and fresh operator decisions.
 * Supply an available unbound planning thread in the same workspace. The host handles
 * native permissions/questions separately, retains all action IDs before calling,
 * and presents exact source before issuing each approval action. On interruption,
 * inspect those identities and the retained revision; never restart this whole flow
 * to retry an uncertain native effect.
 */
export const revisePlan = async (input: {
  stateRoot: string;
  target: IPlanTarget;
  planningThreadId: string;
  amendments: string;
  begin: IPlanOperatorAction;
  threadIds: string[];
  checkouts: IPlanCheckout[];
  finalize: IPlanOperatorAction;
  nativeActionIds: { plan: string; resume: string; breakdown: string; close: string };
  approvePlan: (source: string, status: IPlanStatus) => Promise<IPlanOperatorAction | null>;
  requestBreakdown: (status: IPlanStatus) => Promise<IPlanOperatorAction | null>;
  approveSequence: (
    source: string | null,
    status: IPlanStatus,
  ) => Promise<IPlanOperatorAction | null>;
  authorize: (status: IPlanStatus) => Promise<{
    action: IPlanOperatorAction;
    mode: 'supervised' | 'auto';
    milestoneIds: string[];
  } | null>;
  planningTimeoutSeconds?: number;
}): Promise<IPlanStatus> => {
  const { stateRoot, target, planningThreadId: threadId } = input;
  const runtime = await requestAgentHq(stateRoot, { kind: 'status' });
  if (runtime.kind !== 'status') throw new Error('Expected runtime status');
  const runtimeEpoch = runtime.result.runtimeEpoch;
  const waitOptions = { timeoutSeconds: input.planningTimeoutSeconds ?? 300, intervalSeconds: 0.2 };

  /** Reads current authority without treating a native turn as approval. */
  const status = async (): Promise<IPlanStatus> => {
    const response = await requestAgentHq(stateRoot, {
      kind: 'plan',
      command: { kind: 'status', target },
    });
    if (response.kind !== 'plan' || response.result.kind !== 'status')
      throw new Error('Expected plan status');
    return response.result.result;
  };
  /** Submits one explicit operator command with the current semantic revision. */
  const plan = (command: IPlanCommandInput) => requestAgentHq(stateRoot, { kind: 'plan', command });
  /** Waits for actual native delivery/completion; permission replies remain with the host. */
  const native = async (action: IActionEnvelope, completed = false) => {
    await requestAgentHq(stateRoot, { kind: 'action', action });
    return waitUntil(async () => {
      const response = await requestAgentHq(stateRoot, { kind: 'receipt', actionId: action.id });
      if (response.kind !== 'receipt') throw new Error('Expected action receipt');
      const receipt = response.result;
      if (!receipt) return;
      if (
        ['uncertain', 'failed', 'canceled'].includes(receipt.delivery) ||
        (receipt.completion && receipt.completion !== 'completed')
      )
        throw new Error(`Inspect native action ${action.id} before continuing`);
      return receipt.delivery === 'acknowledged' &&
        (!completed || receipt.completion === 'completed')
        ? receipt
        : undefined;
    }, waitOptions);
  };
  /** Uses the exact native inventory identity, never a fabricated skill name as input. */
  const invoke = async (name: 'jg-plan' | 'jg-breakdown', scope: IPlanActionScope, id: string) => {
    const catalog = await requestAgentHq(stateRoot, {
      kind: 'skills',
      threadId,
      search: name,
      limit: 128,
    });
    if (
      catalog.kind !== 'skills' ||
      catalog.result.state === 'unavailable' ||
      catalog.result.nextCursor
    )
      throw new Error('Select a complete available native skill inventory');
    const skills = catalog.result.data.filter(
      (skill) => skill.name === name && skill.isEnabled && skill.kind !== 'unavailable',
    );
    if (skills.length !== 1) throw new Error(`Expected one available ${name} skill`);
    await native(
      {
        id,
        runtimeEpoch,
        plan: scope,
        command: {
          kind: 'message',
          threadId,
          input: {
            kind: 'skill',
            skillId: skills[0]!.id,
            arguments: `Use the exact selected directory ${JSON.stringify(target.directory)}. ${name === 'jg-plan' ? input.amendments : 'Refresh coverage while retaining verified work and milestone identities.'}`,
          },
        },
      },
      true,
    );
  };

  await plan({
    kind: 'begin-revision',
    target,
    action: input.begin,
    expected: (await status()).revision,
    intent: 'plan',
    threadIds: input.threadIds,
    checkouts: input.checkouts,
  });
  await waitUntil(async () => {
    const current = await status();
    if (current.coordination.revision?.phase === 'blocked')
      throw new Error('Inspect the blocked revision');
    return current.coordination.revision?.phase === 'editing' ? current : undefined;
  }, waitOptions);
  await invoke(
    'jg-plan',
    { kind: 'planning', revisionId: input.begin.id, invocationId: input.begin.id },
    input.nativeActionIds.plan,
  );
  let current = await status();
  const observed = await inspectPlan(target.directory);
  if (observed.plan.state !== 'readable' || observed.plan.sha256 !== current.inspection.plan)
    throw new Error('Present the current plan again after the source change');
  const approval = await input.approvePlan(observed.plan.value.source, current);
  if (!approval) return current;
  await plan({
    kind: 'approve',
    target,
    action: approval,
    expected: current.revision,
    scope: 'plan',
    presentationHash: observed.plan.sha256,
  });

  current = await status();
  const breakdown = await input.requestBreakdown(current);
  if (!breakdown) return current;
  await plan({
    kind: 'revision-invoke',
    target,
    action: breakdown,
    expected: current.revision,
    revisionId: input.begin.id,
    skill: 'jg-breakdown',
  });
  await waitUntil(async () => {
    const current = await status();
    if (current.coordination.revision?.phase === 'blocked')
      throw new Error('Inspect the blocked revision');
    return current.coordination.revision?.phase === 'editing' ? current : undefined;
  }, waitOptions);
  const scope = {
    kind: 'planning' as const,
    revisionId: input.begin.id,
    invocationId: breakdown.id,
  };
  await native({
    id: input.nativeActionIds.resume,
    runtimeEpoch,
    plan: scope,
    command: { kind: 'thread-resume', threadId, operatorConfirmation: breakdown.source.reference },
  });
  await invoke('jg-breakdown', scope, input.nativeActionIds.breakdown);
  await native({
    id: input.nativeActionIds.close,
    runtimeEpoch,
    command: { kind: 'thread-close', threadId },
  });

  current = await status();
  // finalization records jg-breakdown's milestone IDs and carries completion evidence by ID
  const finalized = await plan({
    kind: 'finalize',
    target,
    action: input.finalize,
    expected: current.revision,
  });
  if (finalized.kind !== 'plan' || finalized.result.kind !== 'finalized')
    throw new Error('Expected finalized presentation');
  current = finalized.result.result;
  const sequenceApproval = await input.approveSequence(finalized.result.content, current);
  if (!sequenceApproval) return current;
  if (finalized.result.content !== null)
    await plan({
      kind: 'approve',
      target,
      action: sequenceApproval,
      expected: current.revision,
      scope: 'sequence',
      presentationHash: current.inspection.milestones!,
    });
  current = await status();
  const execution = await input.authorize(current);
  if (!execution) return current;
  await plan({ kind: 'authorize', target, expected: current.revision, ...execution });
  return status();
};
