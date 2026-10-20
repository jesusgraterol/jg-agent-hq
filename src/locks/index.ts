// types
export type { IHqLockOwner, IOwnerLiveness, IHqLockOptions, IHqLockState } from './types.js';

// constants
export { RUNTIME_DIRECTORY, HQ_LOCK_FILE } from './constants.js';

// lock lifecycle
export {
  ensurePrivateRuntimeDirectory,
  isPrivateOwner,
  getOwnerLiveness,
  acquireHqLock,
  withHqLock,
  releaseHqLock,
  readHqLockState,
} from './locks.js';

// internal ownership record validation
export { HqLockOwnerSchema } from './types.js';
