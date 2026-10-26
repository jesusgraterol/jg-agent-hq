import { isException } from 'jg-exception';

import { toPublicError } from '../errors/index.js';

// the only storage diagnosis shown: which package version wrote the storage, never its cause
const WRITER_MESSAGE =
  /^The HQ storage is invalid: written by (?:jg-agent-hq [0-9A-Za-z.+-]{1,64}|another jg-agent-hq version)(?=$|; \[CAUSE\]: )/;

/** Presents static storage diagnoses without exposing diagnostic paths, suffixes or causes. */
export const toCliError = (error: unknown): ReturnType<typeof toPublicError> => {
  if (isException(error) && error.code === 'JG_AGENT_HQ_STORAGE_INVALID')
    return {
      kind: 'state-conflict',
      message: WRITER_MESSAGE.exec(error.message)?.[0] ?? 'The HQ storage is invalid',
    };
  return toPublicError(error);
};
