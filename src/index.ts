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
