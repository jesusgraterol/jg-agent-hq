import { isException } from 'jg-exception';

import { toPublicError } from '../errors/index.js';

// only these operator-facing storage diagnoses bypass the generic IPC presentation
const STORAGE_MESSAGES = {
  JG_AGENT_HQ_STORAGE_UPGRADE_REQUIRED: {
    kind: 'state-conflict',
    message: 'The HQ storage requires an explicit upgrade',
  },
  JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED: {
    kind: 'state-conflict',
    message: 'The HQ storage version is unsupported',
  },
  JG_AGENT_HQ_STORAGE_UPGRADE_FAILED: {
    kind: 'operation-failed',
    message: 'The HQ storage upgrade failed',
  },
  JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN: {
    kind: 'operation-failed',
    message: 'The HQ storage upgrade requires reconciliation',
  },
} as const;

/** Presents static storage instructions without exposing diagnostic paths, suffixes or causes. */
export const toCliError = (error: unknown): ReturnType<typeof toPublicError> => {
  if (isException(error)) {
    for (const [code, presentation] of Object.entries(STORAGE_MESSAGES))
      if (error.code === code) return presentation;
  }
  return toPublicError(error);
};
