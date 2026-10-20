// trusted-boundary page sizes for growing collections
export const DEFAULT_PAGE_SIZE = 32;
export const MAX_PAGE_SIZE = 128;

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
