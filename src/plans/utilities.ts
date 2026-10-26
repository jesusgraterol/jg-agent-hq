import { hashValue } from 'jg-crypto';
import { Exception } from 'jg-exception';
import { stringifyJsonDeterministically } from 'jg-utilities';

import { PlanMetadataSchema, type IPlanRevision } from '../contracts/index.js';

import { observeSequence } from './documents.js';
import type { IParsedMilestone, IPlanContract } from './types.js';

/** Hashes exact inspection bytes or an explicit semantic contract serialization. */
export const hashPlanContent = (content: string | Buffer): string => hashValue(content);

/** HQ execution identities use strict JSON with canonical object key ordering. */
const serialize = (value: unknown): string =>
  stringifyJsonDeterministically(value, { strict: true });

/**
 * Projects the shared document engine into HQ's strict execution contract.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const parsePlanMilestones = (content: string): IParsedMilestone[] =>
  projectPlanMilestones(observeSequence(content));

/** Reuses the same validated observation for binding and HQ semantic projection. */
export const projectPlanMilestones = (
  observation: ReturnType<typeof observeSequence>,
): IParsedMilestone[] => {
  const sharedDigest = hashPlanContent(serialize([observation.shared, observation.metadata]));
  return observation.entries.map((entry) => ({
    ...entry,
    sharedDigest,
    contractDigest: entry.id
      ? getMilestoneContractDigest({ ...entry, id: entry.id, sharedDigest })
      : null,
  }));
};

/**
 * Computes execution identity without declared administrative fields or mutable status markers.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const computePlanRevision = (input: IPlanContract): IPlanRevision =>
  computeObservedPlanRevision({
    ...input,
    milestones: input.milestones === null ? null : parsePlanMilestones(input.milestones),
  });

/**
 * Reuses the already validated selected-document projection for the same read observation.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const computeObservedPlanRevision = (
  input: Omit<IPlanContract, 'milestones'> & { milestones: IParsedMilestone[] | null },
): IPlanRevision => {
  const parsed = PlanMetadataSchema.safeParse(input.metadata);
  if (!parsed.success)
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const planDigest = hashPlanContent(serialize([input.body, parsed.data]));
  const milestones = input.milestones;
  const breakdownDigest = milestones?.every((milestone) => milestone.id)
    ? hashPlanContent(
        serialize([
          planDigest,
          milestones.map((milestone) => [milestone.id, milestone.contractDigest]),
        ]),
      )
    : null;
  return { planDigest, breakdownDigest };
};

/** Compares the complete execution pair, never inspection hashes or mutable status. */
export const isSamePlanRevision = (left: IPlanRevision, right: IPlanRevision): boolean =>
  left.planDigest === right.planDigest && left.breakdownDigest === right.breakdownDigest;

/** Hashes a finalized milestone's complete requirement identity, independent of its ordinal. */
export const getMilestoneContractDigest = (milestone: {
  id: string;
  title: string;
  sharedDigest: string;
  contract: string;
}): string =>
  hashPlanContent(
    serialize([milestone.id, milestone.title, milestone.sharedDigest, milestone.contract]),
  );
