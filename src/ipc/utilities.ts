import { Exception } from 'error-message-utils';
import { z } from 'zod';

import { ErrorKindSchema, PUBLIC_ERROR_MESSAGES, type IErrorKind } from '../contracts/index.js';

const ErrorMetadataSchema = z.object({ kind: ErrorKindSchema });

/** Maps only recognized classifications and static messages across a client boundary. */
export const toPublicError = (error: unknown): { kind: IErrorKind; message: string } => {
  const metadata = ErrorMetadataSchema.safeParse(error instanceof Exception ? error.data : null);
  const kind = metadata.success ? metadata.data.kind : 'operation-failed';
  return { kind, message: PUBLIC_ERROR_MESSAGES[kind] };
};
