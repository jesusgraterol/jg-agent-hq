// state ownership and trusted paths
export {
  prepareStateRoot,
  readExistingState,
  resolveAllowedRoots,
  isWithinWorkspace,
  resolveWorkspaceTarget,
  readRuntimeOwner,
  claimRuntimeOwner,
  prepareDatabase,
  prepareActionKey,
} from './state.js';
export { RUNTIME_OWNER_FILE, DATABASE_FILE } from './constants.js';
