import { randomUUID } from 'node:crypto';
import { Exception } from 'error-message-utils';

import type { IPlanRevision } from '../contracts/index.js';

import { computePlanRevision, isSamePlanRevision, refreshPlanOverview } from './utilities.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', undefined, {
    kind: 'state-conflict',
  });
};

/**
 * Assigns or validates the first sequence's identities and refreshes its derived status table.
 * @returns Canonical content and its revision, without approval.
 * @throws
 * - -1: The HQ action conflicts with its recorded state
 * - -1: The HQ plan is invalid
 */
export const finalizeInitialSequence = (
  artifacts: IPlanArtifacts,
): { content: string; revision: IPlanRevision } => {
  if (
    artifacts.milestones === null ||
    (artifacts.coordination.finalized &&
      !isSamePlanRevision(artifacts.coordination.finalized.revision, artifacts.revision))
  )
    conflict();
  let milestones = artifacts.milestones!.replace(/\r\n?/g, '\n');
  // insertion offsets are applied backwards so original positions stay valid
  for (const milestone of [...artifacts.parsed].reverse())
    if (!milestone.id)
      milestones =
        milestones.slice(0, milestone.statusEnd) +
        `**Milestone ID:** ${randomUUID()}\n` +
        milestones.slice(milestone.statusEnd);
  milestones = refreshPlanOverview(milestones, artifacts.parsed);
  const revised = computePlanRevision({
    ...artifacts.contract,
    milestones,
  });
  return { content: milestones, revision: revised };
};
