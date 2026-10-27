import { createHash } from 'node:crypto';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import type { IHistoryItem } from '../contracts/index.js';

const ContinuationSchema = z.strictObject({
  version: z.literal(1),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  nativeCursor: z.string().min(1).max(12_000),
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

/**
 * Cuts each item's text to a limit on a code-point boundary, marking the items it cut, after
 * everything that compares the persisted text, such as live-item reconciliation, has read it.
 * @param items The items as their provider presents them.
 * @param textLimit The most UTF-16 code units of text an item keeps.
 * @returns The items with their text cut.
 */
export const limitItemText = (items: IHistoryItem[], textLimit: number): IHistoryItem[] =>
  items.map((item) => {
    if (item.text.length <= textLimit) return item;
    const end = /[\uD800-\uDBFF]/.test(item.text.charAt(textLimit - 1)) ? textLimit - 1 : textLimit;
    return { ...item, text: item.text.slice(0, end), isTruncated: true };
  });

/**
 * Counts a text's lines, as a file holding it has them.
 * @param text The text, whose final newline ends its last line.
 * @returns The number of lines, zero for an empty text.
 */
export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
