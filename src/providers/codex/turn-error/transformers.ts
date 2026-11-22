import { redactSecrets, redactUrlQueryParams, SECRET_TOKEN_PATTERNS } from 'jg-utilities';
import { z } from 'zod';

import type { ITurnError } from '../../../contracts/index.js';
import type { ICodexTurnError } from './types.js';

const HttpErrorSchema = z.object({ httpStatusCode: z.number().int().min(100).max(599).nullable() });
const TRANSIENT_CODES = new Set([
  'internalServerError',
  'serverOverloaded',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);
const MANUAL_REVIEW_PATTERN =
  /policy|invalid[ _-]?prompt|content[ _-]?filter|unauthori[sz]ed|authenticat|quota|usage[ _-]?limit|context[ _-]?window|rate[ _-]?limit|permission|access[ _-]?denied/iu;
const SECRET_QUERY_NAMES = [
  'token',
  'access_token',
  'api_key',
  'key',
  'authorization',
  'secret',
  'password',
  'signature',
];
const DIAGNOSTIC_SECRET_PATTERNS = [
  ...SECRET_TOKEN_PATTERNS,
  /\b(?:Bearer|Basic)\s+[^\s,;]+/giu,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu,
];

/** Removes credentials before bounding a diagnostic without splitting its final surrogate pair. */
const safeDiagnostic = (text: string, limit: number): string =>
  redactSecrets(text, { patterns: DIAGNOSTIC_SECRET_PATTERNS })
    .text.replace(/https?:\/\/[^\s"<>]+/gu, (url) => {
      try {
        const address = new URL(redactUrlQueryParams(url, SECRET_QUERY_NAMES));
        address.username = '';
        address.password = '';
        return address.toString();
      } catch {
        return '[redacted URL]';
      }
    })
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/u, '');

/**
 * Projects native diagnostics without treating policy, credential or quota failures as transient.
 * @returns A bounded redacted diagnostic, with conservative recovery eligibility.
 */
export const toTurnError = (error: ICodexTurnError, willRetry: boolean): ITurnError => {
  const entries =
    typeof error.codexErrorInfo === 'object' && error.codexErrorInfo !== null
      ? Object.entries(error.codexErrorInfo)
      : [];
  const code =
    typeof error.codexErrorInfo === 'string'
      ? error.codexErrorInfo
      : entries.length === 1
        ? entries[0]![0]
        : null;
  const parsed = entries.length === 1 ? HttpErrorSchema.safeParse(entries[0]![1]) : null;
  const httpStatusCode = parsed?.success ? (parsed.data.httpStatusCode ?? null) : null;
  const isTransientStatus =
    httpStatusCode === null || httpStatusCode === 408 || httpStatusCode >= 500;
  const requiresReview =
    MANUAL_REVIEW_PATTERN.test(error.message) ||
    MANUAL_REVIEW_PATTERN.test(error.additionalDetails ?? '');
  return {
    code: code ? safeDiagnostic(code, 256) : null,
    message: safeDiagnostic(error.message, 4096),
    details: error.additionalDetails == null ? null : safeDiagnostic(error.additionalDetails, 8192),
    httpStatusCode,
    retryable:
      !willRetry &&
      code !== null &&
      TRANSIENT_CODES.has(code) &&
      (entries.length === 0 || parsed?.success === true) &&
      isTransientStatus &&
      !requiresReview,
    willRetry,
  };
};
