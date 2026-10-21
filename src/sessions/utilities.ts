import { createHash } from 'node:crypto';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

const ContinuationSchema = z.strictObject({
  version: z.literal(1),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  nativeCursor: z.string().min(1).max(8192),
});

// request schemas produce deterministic key ordering before filters are hashed
const hashFilters = (filters: object): string =>
  createHash('sha256').update(JSON.stringify(filters)).digest('hex');

/**
 * Checks query binding before a native continuation is used. Authorization is checked separately.
 * @returns The provider-owned cursor, without interpreting its format.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const decodeHistoryCursor = (
  cursor: string | undefined,
  filters: object,
): string | undefined => {
  if (!cursor) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
      });
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor)
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
      });
    const parsed = ContinuationSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (parsed.filterHash !== hashFilters(filters))
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
      });
    return parsed.nativeCursor;
  } catch (cause) {
    throw new Exception(`The HQ cursor does not match this request: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
};

/** Encodes a validated native continuation with the exact request filters. */
export const encodeHistoryCursor = (nativeCursor: string | null, filters: object): string | null =>
  nativeCursor === null
    ? null
    : Buffer.from(
        JSON.stringify(
          ContinuationSchema.parse({ version: 1, filterHash: hashFilters(filters), nativeCursor }),
        ),
      ).toString('base64url');
