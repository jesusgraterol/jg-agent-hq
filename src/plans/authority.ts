import { Exception } from 'jg-exception';

import type {
  IPlanCommand,
  IPlanStatus,
  IPlanCoordination,
  IPlanOperatorAction,
} from '../contracts/index.js';

import { isSamePlanRevision } from './utilities.js';
import { invalid } from './documents.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/** Derives approval independently from native sessions and native permission requests. */
export const describePlan = (
  artifacts: IPlanArtifacts,
  pendingActionId: string | null = null,
): IPlanStatus => {
  const { revision, coordination } = artifacts;
  const isPlanApproved =
    !!coordination.planApproval &&
    !coordination.planApproval.revokedBy &&
    coordination.planApproval.revision.planDigest === revision.planDigest;
  const isFinalized =
    artifacts.skillsBinding !== 'stale' &&
    !!coordination.finalized &&
    isSamePlanRevision(coordination.finalized.revision, revision);
  const isSequenceApproved =
    isPlanApproved &&
    isFinalized &&
    !!coordination.sequenceApproval &&
    !coordination.sequenceApproval.revokedBy &&
    isSamePlanRevision(coordination.sequenceApproval.revision, revision);
  // a done marker counts only with a current receipt for its milestone ID
  const current = coordination.completions.filter((receipt) => !receipt.reopenedBy);
  const evidenced = new Set(current.map((receipt) => receipt.milestoneId));
  const verified = (milestone: { id: string | null }): boolean =>
    !!milestone.id && evidenced.has(milestone.id);
  const milestoneIds = new Set(artifacts.parsed.map((milestone) => milestone.id));
  const workflow = coordination.revision;
  const isWholePlanComplete =
    artifacts.milestones === null &&
    current.some(
      (receipt) =>
        receipt.milestoneId === null &&
        receipt.contractDigest === revision.planDigest &&
        receipt.revision.breakdownDigest === null,
    );
  const state =
    coordination.observedConflict ||
    pendingActionId ||
    workflow?.phase === 'blocked' ||
    artifacts.parsed.some((milestone) => milestone.status === 'done' && !verified(milestone))
      ? 'blocked'
      : workflow?.phase === 'quiescing' ||
          (workflow?.phase === 'editing' &&
            ((workflow.invocation?.skill === 'jg-plan' &&
              workflow.checkpoint?.revision.planDigest === revision.planDigest) ||
              (workflow.invocation?.skill === 'jg-breakdown' && artifacts.milestones === null)))
        ? 'revising'
        : !isPlanApproved
          ? 'plan-approval-required'
          : !isFinalized
            ? 'breakdown-required'
            : artifacts.milestones !== null && !isSequenceApproved
              ? 'sequence-approval-required'
              : isWholePlanComplete ||
                  (artifacts.parsed.length > 0 &&
                    artifacts.parsed.every(
                      (milestone) => milestone.status === 'done' && verified(milestone),
                    ))
                ? 'completed'
                : artifacts.parsed.some((milestone) => milestone.status === 'in progress')
                  ? 'in-progress'
                  : 'ready';
  return {
    directory: artifacts.directory,
    revision,
    inspection: artifacts.hashes,
    state,
    pendingActionId,
    skillsBinding: artifacts.skillsBinding,
    isFinalized,
    isPlanApproved,
    isSequenceApproved,
    milestoneCount: artifacts.parsed.length,
    coordination: {
      schemaVersion: coordination.schemaVersion,
      finalized: coordination.finalized,
      planApproval: coordination.planApproval,
      sequenceApproval: coordination.sequenceApproval,
      execution: coordination.execution,
      lastActionId: coordination.lastActionId,
      observedConflict: coordination.observedConflict,
      completionCount: coordination.completions.length,
      unmatchedEvidence: current
        .filter((receipt) => receipt.milestoneId !== null && !milestoneIds.has(receipt.milestoneId))
        .map(({ id, milestoneId, title, completedAt }) => ({
          id,
          milestoneId,
          title,
          completedAt,
        })),
      revision: workflow
        ? {
            id: workflow.id,
            action: workflow.action,
            intent: workflow.intent,
            phase: workflow.phase,
            phaseActionId: workflow.phaseActionId,
            ownerRuntimeEpoch: workflow.ownerRuntimeEpoch,
            reason: workflow.reason,
            threadIds: workflow.threadIds,
            invocation: workflow.invocation,
            createdAt: workflow.createdAt,
            hasUncertainEffects: workflow.hasUncertainEffects,
            hasCheckpoint: !!workflow.checkpoint,
          }
        : null,
    },
  };
};

/**
 * Checks the current approved unfinished unit, with null identifying an undivided plan.
 * Runtime epoch, action identity and mode remain the caller's separate admission checks.
 * @returns Whether the exact unit is selected by current execution authority.
 */
export const canExecutePlanUnit = (
  artifacts: IPlanArtifacts,
  milestoneId: string | null,
): boolean => {
  const status = describePlan(artifacts);
  const execution = artifacts.coordination.execution;
  if (
    !execution ||
    !artifacts.conformance.sequence ||
    !status.isPlanApproved ||
    !status.isFinalized ||
    ['blocked', 'completed', 'revising'].includes(status.state)
  )
    return false;
  return artifacts.milestones === null
    ? milestoneId === null && execution.milestoneIds.length === 0
    : status.isSequenceApproved &&
        milestoneId !== null &&
        execution.milestoneIds.includes(milestoneId) &&
        artifacts.parsed.some(
          (milestone) => milestone.id === milestoneId && milestone.status !== 'done',
        );
};

/** Revocation records operator provenance without granting any replacement authority. */
const revokeExecution = (coordination: IPlanCoordination, action: IPlanOperatorAction): void => {
  if (coordination.execution) coordination.execution.revokedBy = action;
};

/**
 * Applies one explicit operator decision without native dispatch or filesystem mutation.
 * A protocol 0.2 plan must pass the jg-plans check for the decision's stage.
 * @returns Updated current authority records.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const updatePlanAuthority = (
  artifacts: IPlanArtifacts,
  command: Extract<IPlanCommand, { kind: 'approve' | 'revoke' | 'authorize' }>,
  runtimeEpoch: string,
): IPlanCoordination => {
  const coordination = structuredClone(artifacts.coordination);
  if (command.kind === 'approve') {
    if (!artifacts.conformance[command.scope]) invalid();
    const status = describePlan(artifacts);
    if (
      command.scope === 'sequence' &&
      (artifacts.milestones === null || !status.isFinalized || !status.isPlanApproved)
    )
      conflict();
    const presentation =
      command.scope === 'plan' ? artifacts.hashes.plan : artifacts.hashes.milestones;
    if (presentation !== command.presentationHash) conflict();
    const receipt = {
      action: command.action,
      revision:
        command.scope === 'plan'
          ? { planDigest: artifacts.revision.planDigest, breakdownDigest: null }
          : artifacts.revision,
      presentationHash: command.presentationHash,
      createdAt: Date.now(),
      revokedBy: null,
    };
    if (command.scope === 'plan') coordination.planApproval = receipt;
    else coordination.sequenceApproval = receipt;
    revokeExecution(coordination, command.action);
  } else if (command.kind === 'revoke') {
    if ((command.scope === 'plan' || command.scope === 'all') && coordination.planApproval)
      coordination.planApproval.revokedBy = command.action;
    if (
      (command.scope === 'sequence' || command.scope === 'all' || command.scope === 'plan') &&
      coordination.sequenceApproval
    )
      coordination.sequenceApproval.revokedBy = command.action;
    revokeExecution(coordination, command.action);
  } else {
    if (!artifacts.conformance.sequence) invalid();
    const status = describePlan(artifacts);
    if (
      coordination.revision &&
      coordination.revision.phase !== 'awaiting-approval' &&
      coordination.revision.phase !== 'finished'
    )
      conflict();
    if (
      status.state === 'blocked' ||
      status.state === 'completed' ||
      !status.isPlanApproved ||
      !status.isFinalized ||
      (artifacts.milestones === null
        ? command.milestoneIds.length !== 0
        : !status.isSequenceApproved || command.milestoneIds.length === 0) ||
      command.milestoneIds.some(
        (id) =>
          !artifacts.parsed.some((milestone) => milestone.id === id && milestone.status !== 'done'),
      )
    )
      conflict();
    if (coordination.revision) coordination.revision.phase = 'finished';
    coordination.observedConflict = null;
    coordination.execution = {
      runtimeEpoch,
      action: command.action,
      revision: artifacts.revision,
      mode: command.mode,
      milestoneIds: command.milestoneIds,
      createdAt: Date.now(),
      revokedBy: null,
    };
  }
  return coordination;
};
