import { isAbsolute } from 'node:path';
import { z } from 'zod';

import type {
  IHqRequestInput,
  IHqResponseOf,
  IBrowserAction,
  IBrowserReceipt,
} from '../contracts/index.js';
import type { IHqSnapshotInspection } from '../snapshots/index.js';
import type { IStorageDescriptor, IStorageMaintenanceOperation } from '../storage/index.js';
import type { IAsyncInputListener } from './async-inputs/index.js';

// construction receives trusted operator configuration, never a browser-selected root
export const AgentHqOptionsSchema = z.strictObject({
  stateRoot: z.string().min(1).refine(isAbsolute),
  allowedRoots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(128),
  codexExtraSkillRoots: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
  // a command and its arguments run before `codex app-server daemon start`, such as a new scope
  codexDaemonLauncher: z.array(z.string().min(1)).min(1).max(16).optional(),
  claudeAdditionalDirectories: z.array(z.string().min(1).refine(isAbsolute)).max(128).optional(),
  /*
   * Runs under exclusive runtime ownership after storage opens, before providers or IPC start.
   * The host owns its connection and rollback; errors propagate unchanged through startup cleanup.
   */
  initializeHostStorage: z
    .custom<IStorageMaintenanceOperation<void>>((input) => typeof input === 'function')
    .optional(),
  /*
   * Proves no process of a runtime that stopped without releasing the state root remains, which
   * lets startup take its runtime lock over and clear the snapshot lock and socket it left.
   */
  isPreviousRuntimeStopped: z
    .custom<IPreviousRuntimeCheck>((input) => typeof input === 'function')
    .optional(),
});
export type IAgentHqOptions = z.infer<typeof AgentHqOptionsSchema>;

// the runtime lock's owner whose process no longer exists, and when it took the lock
export type IPreviousRuntimeOwner = { pid: number; createdAt: string };
// a host check that resolves true only when no process of that runtime remains
export type IPreviousRuntimeCheck = (owner: IPreviousRuntimeOwner) => Promise<boolean>;

// the runtime owns resources independently of every client connection
export type IAgentHq = {
  readonly storage: IStorageDescriptor;
  /**
   * Observes complete controlled-session async items independently of browser reads. The listener
   * synchronously enqueues bounded host work. Recovery signals request native-history catch-up;
   * observations grant no authority. Exceptions are isolated and request recovery. No replay log
   * is retained. Runtime shutdown removes all subscriptions.
   * @returns An idempotent unsubscribe function; a closed runtime retains no listener.
   */
  observeAsyncInputs(listener: IAsyncInputListener): () => void;
  /**
   * Drains the runtime's admitted work and runs a host callback under exclusive maintenance
   * admission. The callback owns its SQLite connection; its errors propagate unchanged.
   * It must not call the runtime or resume native work. Conflicting requests are rejected.
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
  /**
   * Captures the running runtime, host tables and private key while agents keep working, under
   * the state root's snapshot lock, into an absent destination under an existing canonical
   * parent. Host connections must not write host tables until it resolves.
   * @param destination The snapshot directory to create.
   * @returns The verified snapshot's directory, manifest hash and header.
   * @throws
   * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
   * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
   * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  createSnapshot(destination: string): Promise<IHqSnapshotInspection>;
  stateRoot: string;
  // the epoch this runtime binds each action and IPC request to, as `status` reports it
  readonly runtimeEpoch: string;
  closed: Promise<void>;
  /**
   * Performs a validated local command; native failures may retain diagnostic context. A deletion
   * runs within the request and throws its failure.
   * @returns The response to the command's kind. Stop acknowledges admission, not completed
   * shutdown.
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
  request<TCommand extends IHqRequestInput>(
    command: TCommand,
  ): Promise<IHqResponseOf<TCommand['kind']>>;
  /**
   * Closes owned resources before releasing the runtime lock.
   * @returns A promise resolved after confirmed resource shutdown and lock release.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
   */
  close(): Promise<void>;
};
