import { Exception } from 'jg-exception';

import { PlanMilestoneSchema, type IPlanCommand, type IPlanResult } from '../contracts/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

import { isSamePlanRevision } from './utilities.js';
import { PlanMilestonePositionSchema, type IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/**
 * Reads a selected authoritative-file projection through bounded revision-bound seek pages.
 * @returns A milestone page.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readPlanPage = async (
  store: IStore,
  artifacts: IPlanArtifacts,
  command: Extract<IPlanCommand, { kind: 'milestones' }>,
): Promise<IPlanResult> => {
  const filters = {
    directory: artifacts.directory,
    limit: command.limit,
  };
  const decoded = decodeHistoryCursor(command.cursor, filters);
  let after = 0;
  if (decoded) {
    try {
      const position = PlanMilestonePositionSchema.parse(JSON.parse(decoded));
      if (
        !isSamePlanRevision(position.revision, artifacts.revision) ||
        position.inspection !== artifacts.hashes.milestones
      )
        conflict();
      after = position.ordinal;
    } catch (cause) {
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
  }
  await store.projectPlan({
    directory: artifacts.directory,
    sourceHash: artifacts.hashes.milestones,
    milestones: artifacts.parsed.map((milestone) => PlanMilestoneSchema.parse(milestone)),
  });
  const page = await store.listPlanMilestones({
    directory: artifacts.directory,
    limit: command.limit,
    after,
  });
  return {
    kind: 'milestones',
    result: {
      data: page.data,
      nextCursor: encodeHistoryCursor(
        page.hasMore
          ? JSON.stringify({
              ordinal: page.data.at(-1)!.ordinal,
              inspection: artifacts.hashes.milestones,
              revision: artifacts.revision,
            })
          : null,
        filters,
      ),
    },
  };
};
