// state ownership and trusted paths
export {
  prepareStateRoot,
  resolveAllowedRoots,
  isWithinWorkspace,
  resolveWorkspaceTarget,
  readRuntimeOwner,
  claimRuntimeOwner,
  prepareDatabase,
} from './state.js';
export { RUNTIME_OWNER_FILE, DATABASE_FILE } from './constants.js';
