import { Exception } from 'error-message-utils';
import { z } from 'zod';

import { ErrorKindSchema, PUBLIC_ERROR_MESSAGES, type IErrorKind } from '../contracts/index.js';

const ErrorMetadataSchema = z.object({ kind: ErrorKindSchema });

/** Reads only the supported classification from an application exception. */
export const getErrorKind = (error: unknown): IErrorKind => {
  const metadata = ErrorMetadataSchema.safeParse(error instanceof Exception ? error.data : null);
  return metadata.success ? metadata.data.kind : 'operation-failed';
};

/** Maps recognized classifications to static client-safe messages. */
export const toPublicError = (error: unknown): { kind: IErrorKind; message: string } => {
  const kind = getErrorKind(error);
  return { kind, message: PUBLIC_ERROR_MESSAGES[kind] };
};
