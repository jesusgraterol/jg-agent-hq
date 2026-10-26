// execution contract hashing
export {
  computePlanRevision,
  hashPlanContent,
  parsePlanMilestones,
  isSamePlanRevision,
} from './utilities.js';
export { observePlanContract } from './documents.js';
export type {
  IPlanContract,
  IPlanStopJob,
  IParsedMilestone,
  IPlanArtifacts,
  IPlanWriteIntent,
  IPlanProjection,
} from './types.js';
export {
  PlanWriteIntentSchema,
  PlanProjectionSchema,
  PlanProjectionPageSchema,
  PlanProjectionResultSchema,
} from './types.js';
// selected-plan coordination
export { createPlans } from './plans.js';

// revision read projection contracts
export {
  PlanRevisionProjectionSchema,
  PlanRevisionPageSchema,
  PlanRevisionPageResultSchema,
} from './types.js';
export type { IPlanRevisionProjection } from './types.js';
