import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type {
  IHqRequestInput,
  IHqResponse,
  IBrowserAction,
  IBrowserReceipt,
} from '../contracts/index.js';
import type { IStorageDescriptor, IStorageMaintenanceOperation } from '../storage/index.js';

// construction receives trusted operator configuration, never a browser-selected root
export const AgentHqOptionsSchema = z.strictObject({
  stateRoot: z.string().min(1).refine(isAbsolute),
  allowedRoots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(128),
  codexExtraSkillRoots: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
  // a command and its arguments run before `codex app-server daemon start`, such as a new scope
  codexDaemonLauncher: z.array(z.string().min(1)).min(1).max(16).optional(),
  claudeAdditionalDirectories: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
  /*
   * Proves no process of a runtime that stopped without releasing the state root remains, which
   * lets startup replace its owner record and clear its leftover lock and socket. The host
   * guarantees that at most one caller reclaims a given state root at a time.
   */
  isPreviousRuntimeStopped: z
    .custom<IPreviousRuntimeCheck>((input) => typeof input === 'function')
    .optional(),
});
export type IAgentHqOptions = z.infer<typeof AgentHqOptionsSchema>;

// the recorded owner of a state root whose process no longer exists
export type IPreviousRuntimeOwner = { pid: number; createdAt: string };
// a host check that resolves true only when no process of that runtime remains
export type IPreviousRuntimeCheck = (owner: IPreviousRuntimeOwner) => Promise<boolean>;

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
   * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - LOCK_ROOT_INVALID: The locks folder must be an absolute path.
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
