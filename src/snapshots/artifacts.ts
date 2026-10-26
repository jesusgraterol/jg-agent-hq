import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readPrivateFile } from 'jg-fs';
import { parsePlan } from 'jg-plans';

import {
  PlanCoordinationSchema,
  PlanRevisionSchema,
  type IPlanRevision,
} from '../contracts/index.js';
import { computePlanRevision, isSamePlanRevision, observePlanContract } from '../plans/index.js';

import type { ISnapshotPlan } from './types.js';

/**
 * Reads the distinct plan revisions the database's thread bindings record for one plan.
 * @returns At most 32 revisions in a deterministic order.
 */
export const readRecordedRevisions = (database: DatabaseSync, directory: string): IPlanRevision[] =>
  database
    .prepare(
      "SELECT DISTINCT json_extract(context, '$.observedRevision.planDigest') AS plan_digest, json_extract(context, '$.observedRevision.breakdownDigest') AS breakdown_digest FROM hq_thread_plan WHERE directory = ? ORDER BY plan_digest, breakdown_digest LIMIT 32",
    )
    .all(directory)
    .map((row) =>
      PlanRevisionSchema.parse({
        planDigest: row.plan_digest,
        breakdownDigest: row.breakdown_digest,
      }),
    );

/**
 * Observes identities and diagnostics in one captured artifact set without repairing source state.
 * A plan whose copied revision differs from one its captured database records changed during
 * capture or since those bindings were made, so restore treats its execution authority as stale.
 * Parser observations never become an approval or a conformance requirement for capture.
 * @returns Bounded identity and diagnostic fields for the inventory record.
 */
export const observeSnapshotPlan = async (
  directory: string,
  files: Pick<ISnapshotPlan, 'plan' | 'milestones' | 'coordination'>,
  recordedRevisions: IPlanRevision[],
): Promise<Pick<ISnapshotPlan, 'planId' | 'revision' | 'recordedRevisions' | 'diagnostics'>> => {
  const result: Pick<ISnapshotPlan, 'planId' | 'revision' | 'recordedRevisions' | 'diagnostics'> = {
    planId: null,
    revision: null,
    recordedRevisions,
    diagnostics: [],
  };
  if (!files.plan) result.diagnostics.push('plan-missing');
  else {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    try {
      const plan = decoder.decode(
        await readPrivateFile(join(directory, 'plan.md'), {
          maxBytes: 1_048_576,
          rootPath: directory,
        }),
      );
      const milestones = files.milestones
        ? decoder.decode(
            await readPrivateFile(join(directory, 'milestones.md'), {
              maxBytes: 1_048_576,
              rootPath: directory,
            }),
          )
        : null;
      const document = parsePlan(plan);
      if (typeof document.metadata.id === 'string') result.planId = document.metadata.id;
      if (document.diagnostics.some((entry) => entry.severity === 'error'))
        result.diagnostics.push('plan-diagnostics');
      result.revision = computePlanRevision({ ...observePlanContract(plan), milestones });
    } catch {
      if (!result.diagnostics.includes('plan-diagnostics'))
        result.diagnostics.push('plan-diagnostics');
    }
  }
  if (files.coordination) {
    const bytes = await readPrivateFile(join(directory, 'coordination.json'), {
      maxBytes: 8_388_608,
      rootPath: directory,
    });
    try {
      if (
        !PlanCoordinationSchema.safeParse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ).success
      )
        result.diagnostics.push('coordination-invalid');
    } catch {
      result.diagnostics.push('coordination-invalid');
    }
  }
  const revision = result.revision;
  if (recordedRevisions.some((recorded) => !revision || !isSamePlanRevision(recorded, revision)))
    result.diagnostics.push('plan-changed');
  return result;
};
