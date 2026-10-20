import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type { IHqRequestInput, IHqResponse } from '../contracts/index.js';

// construction receives trusted operator configuration, never a browser-selected root
export const AgentHqOptionsSchema = z.strictObject({
  stateRoot: z.string().min(1).refine(isAbsolute),
  allowedRoots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(128),
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
   * - -1: The Codex integration failed
   * - -1: The HQ store failed
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
