import { Exception } from 'error-message-utils';

import type {
  IPlanCommand,
  IPlanStatus,
  IPlanCoordination,
  IPlanOperatorAction,
} from '../contracts/index.js';

import { isSamePlanRevision } from './utilities.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', undefined, {
    kind: 'state-conflict',
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
    !!coordination.finalized &&
    revision.breakdownDigest !== null &&
    isSamePlanRevision(coordination.finalized.revision, revision);
  const isSequenceApproved =
    isPlanApproved &&
    isFinalized &&
    !!coordination.sequenceApproval &&
    !coordination.sequenceApproval.revokedBy &&
    isSamePlanRevision(coordination.sequenceApproval.revision, revision);
  const state =
    pendingActionId || artifacts.parsed.some((milestone) => milestone.status === 'done')
      ? 'blocked'
      : !isPlanApproved
        ? 'plan-approval-required'
        : !isFinalized
          ? 'breakdown-required'
          : !isSequenceApproved
            ? 'sequence-approval-required'
            : artifacts.parsed.some((milestone) => milestone.status === 'in progress')
              ? 'in-progress'
              : 'ready';
  return {
    directory: artifacts.directory,
    revision,
    inspection: artifacts.hashes,
    state,
    pendingActionId,
    isFinalized,
    isPlanApproved,
    isSequenceApproved,
    milestoneCount: artifacts.parsed.length,
    coordination,
  };
};

/** Revocation records operator provenance without granting any replacement authority. */
const revokeExecution = (coordination: IPlanCoordination, action: IPlanOperatorAction): void => {
  if (coordination.execution) coordination.execution.revokedBy = action;
};

/**
 * Applies one explicit operator decision without native dispatch or filesystem mutation.
 * @returns Updated current authority records.
 * @throws
 * - -1: The HQ action conflicts with its recorded state
 */
export const updatePlanAuthority = (
  artifacts: IPlanArtifacts,
  command: Extract<IPlanCommand, { kind: 'approve' | 'revoke' | 'authorize' }>,
): IPlanCoordination => {
  const coordination = structuredClone(artifacts.coordination);
  if (command.kind === 'approve') {
    const status = describePlan(artifacts);
    if (command.scope === 'sequence' && (!status.isFinalized || !status.isPlanApproved)) conflict();
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
    const status = describePlan(artifacts);
    if (
      status.state === 'blocked' ||
      !status.isSequenceApproved ||
      command.milestoneIds.some(
        (id) =>
          !artifacts.parsed.some((milestone) => milestone.id === id && milestone.status !== 'done'),
      )
    )
      conflict();
    coordination.execution = {
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
