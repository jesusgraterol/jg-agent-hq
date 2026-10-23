import { join } from 'node:path';
import { readPrivateFile } from 'jg-fs';
import { parsePlan } from 'jg-plans';

import { PlanCoordinationSchema } from '../contracts/index.js';

import type { ISnapshotPlan } from './types.js';

/**
 * Observes identities and diagnostics in one captured artifact set without repairing source state.
 * Parser observations never become an approval or a conformance requirement for capture.
 * @returns Bounded identity and diagnostic fields for the inventory record.
 */
export const observeSnapshotPlan = async (
  directory: string,
  files: Pick<ISnapshotPlan, 'plan' | 'coordination'>,
): Promise<Pick<ISnapshotPlan, 'planId' | 'revision' | 'diagnostics'>> => {
  const result: Pick<ISnapshotPlan, 'planId' | 'revision' | 'diagnostics'> = {
    planId: null,
    revision: null,
    diagnostics: [],
  };
  if (!files.plan) result.diagnostics.push('plan-missing');
  else {
    const bytes = await readPrivateFile(join(directory, 'plan.md'), {
      maxBytes: 1_048_576,
      rootPath: directory,
    });
    try {
      const plan = parsePlan(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      );
      if (typeof plan.metadata.id === 'string') result.planId = plan.metadata.id;
      if (typeof plan.metadata.revision === 'number') result.revision = plan.metadata.revision;
      if (plan.diagnostics.some((entry) => entry.severity === 'error'))
        result.diagnostics.push('plan-diagnostics');
    } catch {
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
  return result;
};
