// trusted-boundary page sizes for growing collections
export const DEFAULT_PAGE_SIZE = 32;
export const MAX_PAGE_SIZE = 128;

// stable client codes for failures translated at IPC and browser boundaries
export const PUBLIC_ERROR_CODES = {
  'invalid-request': 'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
  'authentication-required': 'JG_AGENT_HQ_CLIENT_AUTHENTICATION_REQUIRED',
  'access-denied': 'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
  'not-found': 'JG_AGENT_HQ_CLIENT_NOT_FOUND',
  'state-conflict': 'JG_AGENT_HQ_CLIENT_STATE_CONFLICT',
  'agent-unavailable': 'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
  'operation-failed': 'JG_AGENT_HQ_CLIENT_OPERATION_FAILED',
} as const;

// safe messages at IPC and browser boundaries
export const PUBLIC_ERROR_MESSAGES = {
  'invalid-request': 'Request is invalid.',
  'authentication-required': 'Sign in to continue.',
  'access-denied': 'Access is denied.',
  'not-found': 'Requested resource was not found.',
  'state-conflict': 'State changed. Refresh before continuing.',
  'agent-unavailable': 'Coding agent is unavailable.',
  'operation-failed': 'Operation could not be completed.',
} as const;
