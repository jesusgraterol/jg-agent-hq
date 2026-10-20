import { Exception } from 'error-message-utils';

import { PlanMilestoneSchema, type IPlanCommand, type IPlanResult } from '../contracts/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

import { projectPlanRevision } from './revisions.js';
import { isSamePlanRevision } from './utilities.js';
import {
  PlanMilestonePositionSchema,
  PlanRevisionPositionSchema,
  type IPlanArtifacts,
} from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', undefined, {
    kind: 'state-conflict',
  });
};

/**
 * Reads a selected authoritative-file projection through bounded revision-bound seek pages.
 * @returns A milestone or retained-evidence page.
 * @throws
 * - -1: The HQ cursor does not match this request
 * - -1: The HQ store failed
 */
export const readPlanPage = async (
  store: IStore,
  artifacts: IPlanArtifacts,
  command: Extract<IPlanCommand, { kind: 'milestones' | 'reconciliation' }>,
): Promise<IPlanResult> => {
  if (command.kind === 'milestones') {
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
        throw new Exception(
          'The HQ cursor does not match this request',
          undefined,
          { kind: 'invalid-request' },
          { cause },
        );
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
  }
  {
    const filters = {
      directory: artifacts.directory,
      collection: command.collection,
      limit: command.limit,
    };
    const decoded = decodeHistoryCursor(command.cursor, filters);
    let after = '';
    if (decoded) {
      try {
        const position = PlanRevisionPositionSchema.parse(JSON.parse(decoded));
        if (position.inspection !== artifacts.hashes.coordination) conflict();
        after = position.id;
      } catch (cause) {
        throw new Exception(
          'The HQ cursor does not match this request',
          undefined,
          { kind: 'invalid-request' },
          { cause },
        );
      }
    }
    await store.projectPlanRevision(projectPlanRevision(artifacts));
    const page = await store.listPlanRevision({ ...filters, after });
    return {
      kind: 'reconciliation',
      result: {
        data: page.data,
        nextCursor: encodeHistoryCursor(
          page.hasMore
            ? JSON.stringify({ id: page.lastId, inspection: artifacts.hashes.coordination })
            : null,
          filters,
        ),
      },
    };
  }
};
