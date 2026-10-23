import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type {
  IHqRequestInput,
  IHqResponse,
  IBrowserAction,
  IBrowserReceipt,
} from '../contracts/index.js';
import type { IPlanContractParser } from '../plans/index.js';
import type { IStorageDescriptor, IStorageMaintenanceOperation } from '../storage/index.js';

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
  readonly storage: IStorageDescriptor;
  /**
   * Drains admitted HQ work and runs a host callback under exclusive maintenance admission.
   * The callback owns its SQLite connection; its errors propagate unchanged.
   * It must not call HQ or resume native work. Conflicting requests are rejected.
   * @returns The callback result after maintenance is released.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  withStorageMaintenance<T>(operation: IStorageMaintenanceOperation<T>): Promise<T>;
  /**
   * Runs one trusted host dispatcher after durable admission. Never expose the callback as RPC.
   * Dispatcher failures propagate after the receipt becomes uncertain.
   * @returns Its receipt; replays do not execute the dispatcher.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  performBrowserAction(
    input: IBrowserAction,
    operatorId: string,
    execute: (action: IBrowserAction, nativeActionId: string) => Promise<void>,
  ): Promise<IBrowserReceipt>;
  /**
   * Reconciles a selected receipt for its authenticated operator without repeating effects.
   * @returns The receipt, or null for another operator or unknown ID.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  readBrowserAction(id: string, operatorId: string): Promise<IBrowserReceipt | null>;
  stateRoot: string;
  closed: Promise<void>;
  /**
   * Performs a validated local command; native failures may retain diagnostic context.
   * @returns A normalized response. Stop acknowledges admission, not completed shutdown.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_HANDOFF_UNAVAILABLE: The HQ handoff is unavailable
   * - JG_AGENT_HQ_HANDOFF_FAILED: The HQ handoff operation failed
   * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
   * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
   * - JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS: The HQ lock acquisition arguments are invalid
   * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
   * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
   * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
   * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
   * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
   * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
   * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
   * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
   * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
   * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
   * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
   * - JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED: HQ lock ownership changed before release
   */
  request(command: IHqRequestInput): Promise<IHqResponse>;
  /**
   * Closes owned resources before removing the exact lifetime record.
   * @returns A promise resolved after confirmed resource shutdown and owner release.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
   * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
   * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
   * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
   */
  close(): Promise<void>;
};
