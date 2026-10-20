import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type { IHqRequestInput, IHqResponse } from '../contracts/index.js';
import type { IPlanContractParser } from '../plans/index.js';

// construction receives trusted operator configuration, never a browser-selected root
export const AgentHqOptionsSchema = z.strictObject({
  stateRoot: z.string().min(1).refine(isAbsolute),
  coordinationRoot: z.string().min(1).refine(isAbsolute).optional(),
  parsePlanContract: z
    .custom<IPlanContractParser>((input) => typeof input === 'function')
    .optional(),
  allowedRoots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(128),
  codexExtraSkillRoots: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
  claudeAdditionalDirectories: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
});
export type IAgentHqOptions = z.infer<typeof AgentHqOptionsSchema>;

// the runtime owns resources independently of every client connection
export type IAgentHq = {
  stateRoot: string;
  closed: Promise<void>;
  /**
   * Performs a validated local command; native failures may retain diagnostic context.
   * @returns A normalized response. Stop acknowledges admission, not completed shutdown.
   * @throws
   * - -1: The HQ request is invalid
   * - -1: The HQ runtime is not running
   * - -1: The HQ target is outside the allowed workspaces
   * - -1: The HQ cursor does not match this request
   * - -1: The HQ skill is unavailable
   * - -1: The HQ action conflicts with its recorded state
   * - -1: The Codex integration failed
   * - -1: The Claude integration failed
   * - -1: The Claude history is unavailable
   * - -1: The HQ store failed
   * - -1: The HQ plan is invalid
   * - -1: The HQ plan operation failed
   * - -1: The HQ lock acquisition arguments are invalid
   * - -1: The HQ lock requires Linux or macOS
   * - -1: The HQ runtime directory must be a real directory
   * - -1: The HQ runtime directory must be private and owned by the current user
   * - -1: The HQ lock must be a regular file
   * - -1: The HQ lock must be private and owned by the current user
   * - -1: The HQ lock owner exceeds the supported size
   * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
   * - -1: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
   * - -1: The HQ lock has an inactive owner
   * - -1: The HQ lock owner could not be verified
   * - -1: Timed out waiting for the HQ lock
   * - -1: HQ lock ownership changed before release
   */
  request(command: IHqRequestInput): Promise<IHqResponse>;
  /**
   * Closes owned resources before removing the exact lifetime record.
   * @returns A promise resolved after confirmed resource shutdown and owner release.
   * @throws
   * - -1: The HQ transport failed
   * - -1: The HQ state directory is unsafe
   * - -1: The HQ state file is unsafe
   * - -1: The HQ runtime owner is unverifiable
   * - -1: The HQ runtime is not running
   */
  close(): Promise<void>;
};
