import { isException } from 'jg-exception';
import { z } from 'zod';

import {
  ActionReceiptSchema,
  ErrorKindSchema,
  PUBLIC_ERROR_MESSAGES,
  type IActionReceipt,
  type IErrorKind,
} from '../contracts/index.js';

const ErrorMetadataSchema = z.object({ kind: ErrorKindSchema });
// a failure that left a native process or worker whose shutdown couldn't be confirmed
const CleanupUnconfirmedSchema = z.object({ cleanupUnconfirmed: z.literal(true) });
// the kinds of failure an action's receipt records
const ActionFailureSchema = ActionReceiptSchema.shape.failure.unwrap();

/** Reads only the supported classification from an application exception. */
export const getErrorKind = (error: unknown): IErrorKind => {
  const metadata = ErrorMetadataSchema.safeParse(isException(error) ? error.data : null);
  return metadata.success ? metadata.data.kind : 'operation-failed';
};

/**
 * Classifies why an action failed for its receipt.
 * @param error The failure.
 * @returns Its kind when a receipt records that kind, otherwise operation-failed.
 */
export const toActionFailure = (error: unknown): NonNullable<IActionReceipt['failure']> => {
  const failure = ActionFailureSchema.safeParse(getErrorKind(error));
  return failure.success ? failure.data : 'operation-failed';
};

/**
 * Tells whether a failure left native work whose cleanup couldn't be confirmed, which callers must
 * surface instead of treating the work as stopped.
 * @param error The failure.
 * @returns Whether it is an application exception marked cleanupUnconfirmed.
 */
export const isCleanupUnconfirmed = (error: unknown): boolean =>
  isException(error) && CleanupUnconfirmedSchema.safeParse(error.data).success;

/** Maps recognized classifications to static client-safe messages. */
export const toPublicError = (error: unknown): { kind: IErrorKind; message: string } => {
  const kind = getErrorKind(error);
  return { kind, message: PUBLIC_ERROR_MESSAGES[kind] };
};
