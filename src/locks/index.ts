// types
export type { IHqLockOwner, IOwnerLiveness, IHqLockOptions, IHqLockState } from './types.js';

// constants
export { RUNTIME_DIRECTORY, HQ_LOCK_FILE } from './constants.js';

// lock lifecycle
export {
  getOwnerLiveness,
  acquireHqLock,
  withHqLock,
  releaseHqLock,
  readHqLockState,
} from './locks.js';
