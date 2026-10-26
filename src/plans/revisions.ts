import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';

import {
  PlanSnapshotMilestoneSchema,
  type IPlanCheckpoint,
  type IPlanCoordination,
  type IPlanOperatorAction,
  type IPlanCheckout,
  type IPlanWorktreeProof,
  type IPlanCompletion,
} from '../contracts/index.js';

import { isSamePlanRevision, parsePlanMilestones } from './utilities.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/**
 * Saves the current contract, milestone identities and progress before planning edits begin.
 * @returns A durable snapshot; native quiescence and worktree evidence are recorded separately.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const capturePlanCheckpoint = (
  artifacts: IPlanArtifacts,
  threadIds: string[],
): IPlanCheckpoint => {
  const baseline = artifacts.coordination.baseline;
  if (baseline && !isSamePlanRevision(baseline.revision, artifacts.revision))
    return {
      ...structuredClone(baseline),
      threadIds,
      checkouts: [],
      isQuiescent: false,
      capturedAt: Date.now(),
    };
  return {
    revision: artifacts.revision,
    plan: artifacts.plan,
    milestones: artifacts.milestones,
    entries: artifacts.parsed.map((entry) => PlanSnapshotMilestoneSchema.parse(entry)),
    threadIds,
    checkouts: [],
    isQuiescent: false,
    capturedAt: Date.now(),
  };
};

/**
 * Closes execution authority before asynchronous interruption and background cleanup.
 * @returns Current coordination with one persisted revision owner and checkpoint.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const beginPlanRevision = (
  artifacts: IPlanArtifacts,
  input: {
    action: IPlanOperatorAction;
    intent: 'plan' | 'breakdown';
    ownerRuntimeEpoch: string;
    threadIds: string[];
    checkouts: IPlanCheckout[];
  },
): IPlanCoordination => {
  const coordination = structuredClone(artifacts.coordination);
  if (
    coordination.revision &&
    !['finished', 'awaiting-approval'].includes(coordination.revision.phase)
  )
    conflict();
  coordination.observedConflict = null;
  if (coordination.execution) coordination.execution.revokedBy = input.action;
  const checkpoint = capturePlanCheckpoint(artifacts, input.threadIds);
  coordination.revision = {
    id: input.action.id,
    action: input.action,
    intent: input.intent,
    phase: 'quiescing',
    phaseActionId: input.action.id,
    ownerRuntimeEpoch: input.ownerRuntimeEpoch,
    checkpointActionId: randomUUID(),
    blockActionId: randomUUID(),
    controls: input.threadIds.map((threadId) => ({
      threadId,
      interruptActionId: randomUUID(),
      closeActionId: randomUUID(),
    })),
    reason: null,
    threadIds: input.threadIds,
    checkouts: input.checkouts,
    checkpoint,
    invocation: null,
    createdAt: Date.now(),
    hasUncertainEffects:
      !!artifacts.coordination.observedConflict ||
      !isSamePlanRevision(checkpoint.revision, artifacts.revision),
  };
  return coordination;
};

/**
 * Records proven native shutdown and exact partial work before opening the editing lease.
 * @returns The checkpointed editing state; it never approves contracts or resumes implementation.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const finishPlanCheckpoint = (
  artifacts: IPlanArtifacts,
  revisionId: string,
  checkouts: IPlanWorktreeProof[],
): IPlanCoordination => {
  const coordination = structuredClone(artifacts.coordination);
  const workflow = coordination.revision;
  if (
    !workflow ||
    workflow.id !== revisionId ||
    !workflow.checkpoint ||
    !['quiescing', 'blocked'].includes(workflow.phase)
  )
    conflict();
  const checkpoint = workflow!.checkpoint!;
  if (
    !workflow!.hasUncertainEffects &&
    !isSamePlanRevision(checkpoint.revision, artifacts.revision)
  )
    conflict();
  if (
    isSamePlanRevision(checkpoint.revision, artifacts.revision) &&
    artifacts.milestones !== null
  ) {
    checkpoint.entries = artifacts.parsed.map((entry) => PlanSnapshotMilestoneSchema.parse(entry));
    checkpoint.milestones = artifacts.milestones;
  }
  checkpoint.checkouts = checkouts;
  checkpoint.isQuiescent = true;
  checkpoint.capturedAt = Date.now();
  workflow!.phase = 'editing';
  workflow!.reason = null;
  workflow!.invocation = {
    action: workflow!.action,
    skill: workflow!.intent === 'plan' ? 'jg-plan' : 'jg-breakdown',
  };
  return coordination;
};

/**
 * Retains the exact verified contract and actual operator-supplied check references.
 * @returns A new completion record; no marker or imported agent claim creates one.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const recordPlanCompletion = (
  artifacts: IPlanArtifacts,
  input: {
    action: IPlanOperatorAction;
    milestoneId: string | null;
    checks: IPlanCompletion['checks'];
  },
  checkouts: IPlanWorktreeProof[],
): IPlanCompletion => {
  if (input.milestoneId === null) {
    if (artifacts.milestones !== null) conflict();
    return {
      id: input.action.id,
      action: input.action,
      milestoneId: null,
      revision: artifacts.revision,
      contractDigest: artifacts.revision.planDigest,
      title: 'Whole plan',
      contract: artifacts.contract.body,
      sharedDigest: null,
      checkouts,
      checks: input.checks,
      completedAt: Date.now(),
      reopenedBy: null,
    };
  }
  const milestone =
    artifacts.parsed.find((entry) => entry.id === input.milestoneId) ??
    artifacts.coordination.revision?.checkpoint?.entries.find(
      (entry) => entry.id === input.milestoneId,
    );
  if (!milestone?.id || !milestone.contractDigest) conflict();
  return {
    id: input.action.id,
    action: input.action,
    milestoneId: input.milestoneId,
    revision: artifacts.revision,
    contractDigest: milestone!.contractDigest!,
    title: milestone!.title,
    contract: milestone!.contract,
    sharedDigest: milestone!.sharedDigest,
    checkouts,
    checks: input.checks,
    completedAt: Date.now(),
    reopenedBy: null,
  };
};

/**
 * Retains the latest finalized identities and progress, so a later checkpoint starts from them
 * even after the files were edited directly.
 * @returns A new baseline without changing original completion receipts.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const refreshPlanBaseline = (
  artifacts: IPlanArtifacts,
  content: string | null,
  revision: IPlanCheckpoint['revision'],
): IPlanCheckpoint => {
  const previous = artifacts.coordination.revision?.checkpoint ?? artifacts.coordination.baseline;
  return {
    revision,
    plan: artifacts.plan,
    milestones: content,
    entries:
      content === null
        ? []
        : parsePlanMilestones(content).map((entry) => PlanSnapshotMilestoneSchema.parse(entry)),
    checkouts: previous?.checkouts ?? [],
    threadIds: previous?.threadIds ?? [],
    isQuiescent: previous?.isQuiescent ?? true,
    capturedAt: Date.now(),
  };
};
