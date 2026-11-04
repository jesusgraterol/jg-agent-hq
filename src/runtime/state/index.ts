// state ownership and trusted paths
export {
  isPrivateOwner,
  toLocksRoot,
  prepareStateRoot,
  resolveAllowedRoots,
  resolveWorkspaceTarget,
  readRuntimeOwner,
  claimRuntimeOwner,
  recoverSnapshotLock,
  prepareDatabase,
  prepareActionKey,
} from './state.js';

// constants
export { SNAPSHOT_LOCK } from './constants.js';
