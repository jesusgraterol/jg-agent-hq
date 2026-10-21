import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';

import type { IPlanRevision } from '../contracts/index.js';

import { computePlanRevision, isSamePlanRevision, refreshPlanOverview } from './utilities.js';
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
 * Assigns or validates the first sequence's identities and refreshes its derived status table.
 * @returns Canonical content and its revision, without approval.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const finalizeInitialSequence = (
  artifacts: IPlanArtifacts,
): { content: string | null; revision: IPlanRevision } => {
  if (
    artifacts.coordination.finalized &&
    !isSamePlanRevision(artifacts.coordination.finalized.revision, artifacts.revision)
  )
    conflict();
  if (artifacts.milestones === null) return { content: null, revision: artifacts.revision };
  let milestones = artifacts.milestones.replace(/\r\n?/g, '\n');
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
