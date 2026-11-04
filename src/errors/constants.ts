import { defineErrorCatalog } from 'jg-exception';

// every error HQ throws by kind, with its stable code and message, as errors/README.md lists them
export const HQ_ERROR_ENTRIES = {
  stateDirectoryUnsafe: {
    code: 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE',
    message: 'The HQ state directory is unsafe',
  },
  stateFileUnsafe: {
    code: 'JG_AGENT_HQ_STATE_FILE_UNSAFE',
    message: 'The HQ state file is unsafe',
  },
  runtimeAlreadyOwned: {
    code: 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    message: 'The HQ runtime is already owned',
  },
  runtimeOwnerUnverifiable: {
    code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
    message: 'The HQ runtime owner is unverifiable',
  },
  requestInvalid: { code: 'JG_AGENT_HQ_REQUEST_INVALID', message: 'The HQ request is invalid' },
  targetForbidden: {
    code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
    message: 'The HQ target is outside the allowed workspaces',
  },
  cursorInvalid: {
    code: 'JG_AGENT_HQ_CURSOR_INVALID',
    message: 'The HQ cursor does not match this request',
  },
  codexFailed: { code: 'JG_AGENT_HQ_CODEX_FAILED', message: 'The Codex integration failed' },
  claudeFailed: { code: 'JG_AGENT_HQ_CLAUDE_FAILED', message: 'The Claude integration failed' },
  claudeHistoryUnavailable: {
    code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
    message: 'The Claude history is unavailable',
  },
  transportFailed: { code: 'JG_AGENT_HQ_TRANSPORT_FAILED', message: 'The HQ transport failed' },
  storeFailed: { code: 'JG_AGENT_HQ_STORE_FAILED', message: 'The HQ store failed' },
  storageInvalid: { code: 'JG_AGENT_HQ_STORAGE_INVALID', message: 'The HQ storage is invalid' },
  snapshotInvalid: { code: 'JG_AGENT_HQ_SNAPSHOT_INVALID', message: 'The HQ snapshot is invalid' },
  snapshotFailed: {
    code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
    message: 'The HQ snapshot operation failed',
  },
  providerFailed: {
    code: 'JG_AGENT_HQ_PROVIDER_FAILED',
    message: 'The HQ provider integration failed',
  },
  capabilityUnavailable: {
    code: 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
    message: 'The HQ capability is unavailable',
  },
  runtimeNotRunning: {
    code: 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
    message: 'The HQ runtime is not running',
  },
  actionConflict: {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    message: 'The HQ action conflicts with its recorded state',
  },
  actionKeyUnavailable: {
    code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
    message: 'The HQ action key is unavailable',
  },
  skillUnavailable: {
    code: 'JG_AGENT_HQ_SKILL_UNAVAILABLE',
    message: 'The HQ skill is unavailable',
  },
  imageUnavailable: {
    code: 'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
    message: 'The HQ image is unavailable',
  },
} as const;

// creates HQ's errors by kind, so every throw site uses the documented code and message
export const HQ_ERRORS = defineErrorCatalog(HQ_ERROR_ENTRIES);
