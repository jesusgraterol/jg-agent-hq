// shared lock contracts and lifecycle
export {
  type IHqLockOwner,
  type IOwnerLiveness,
  type IHqLockOptions,
  type IHqLockState,
  RUNTIME_DIRECTORY,
  HQ_LOCK_FILE,
  getOwnerLiveness,
  acquireHqLock,
  withHqLock,
  releaseHqLock,
  readHqLockState,
} from './locks/index.js';

// native runtime and local client
export { createAgentHq } from './runtime/index.js';
export type { IAgentHq, IAgentHqOptions } from './runtime/index.js';
export { requestAgentHq } from './ipc/index.js';

// trusted host storage
export type { IStorageDescriptor, IStorageMaintenanceOperation } from './storage/index.js';

// pure execution revision contracts
export { computePlanRevision } from './plans/index.js';
export type { IPlanContract, IPlanContractParser } from './plans/index.js';
