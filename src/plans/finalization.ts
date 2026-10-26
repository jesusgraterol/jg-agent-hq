import type { IPlanCoordination, IPlanOperatorAction } from '../contracts/index.js';

import { hashPlanContent } from './utilities.js';
import { invalid } from './documents.js';
import { refreshPlanBaseline } from './revisions.js';
import type { IPlanArtifacts } from './types.js';

/**
 * Records the current jg-breakdown identities as the finalized revision without changing any file.
 * Completion evidence follows its milestone ID: receipts of a milestone the sequence no longer
 * marks done stop counting, and receipts whose ID left the sequence remain as unmatched evidence.
 * @returns Coordination carrying the finalization, baseline and reopened receipts.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const finalizePlanSequence = (
  artifacts: IPlanArtifacts,
  current: IPlanCoordination,
  action: IPlanOperatorAction,
): IPlanCoordination => {
  if (artifacts.parsed.some((entry) => !entry.id)) invalid();
  const coordination = structuredClone(current);
  const statuses = new Map(artifacts.parsed.map((entry) => [entry.id, entry.status]));
  for (const receipt of coordination.completions) {
    const status = receipt.milestoneId === null ? undefined : statuses.get(receipt.milestoneId);
    if (status && status !== 'done' && !receipt.reopenedBy) receipt.reopenedBy = action.id;
  }
  coordination.finalized = {
    action,
    revision: artifacts.revision,
    fileHash: artifacts.milestones === null ? null : hashPlanContent(artifacts.milestones),
    createdAt: Date.now(),
  };
  coordination.baseline = refreshPlanBaseline(artifacts, artifacts.milestones, artifacts.revision);
  return coordination;
};
