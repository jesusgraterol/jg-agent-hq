import { hasErrorCode } from 'jg-exception';
import { compareCodePoints } from 'jg-utilities';

import { HQ_ERRORS } from '../../errors/index.js';
import { createRequestCursors } from '../utilities.js';

import { DiscoveryPositionSchema, type IDiscoveryPosition, type IListKey } from './types.js';

// a `threads` cursor, bound to the folders, providers, search and continued filter it lists
const discoveryCursors = createRequestCursors(DiscoveryPositionSchema);

/**
 * Orders sessions as a list holds them: last activity, then provider, then native ID, each
 * descending, the IDs by code point as SQLite compares text.
 * @returns A negative number when the left session comes first.
 */
export const compareListKeys = (left: IListKey, right: IListKey): number =>
  right.updatedAt - left.updatedAt ||
  compareCodePoints(right.provider, left.provider) ||
  compareCodePoints(right.nativeId, left.nativeId);

/** @returns A session's place in a list. */
export const toListKey = ({ updatedAt, provider, nativeId }: IListKey): IListKey => ({
  updatedAt,
  provider,
  nativeId,
});

/**
 * Decodes a `threads` cursor for the filters it must continue, with one state per source.
 * @param cursor The cursor, if any.
 * @param filters The read's normalized folders, providers, search and continued filter.
 * @param sourceCount How many folder and provider pairs the read lists.
 * @returns The position, or undefined for a first page.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const decodeDiscoveryCursor = (
  cursor: string | undefined,
  filters: object,
  sourceCount: number,
): IDiscoveryPosition | undefined => {
  const position = discoveryCursors.decode(cursor, filters);
  if (position && position.sources.length !== sourceCount)
    throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
  return position;
};

/**
 * Encodes where the next `threads` page starts. Every source's continuation fits within the
 * cursor's 16,384 characters for 128 sources with native continuations of up to about 100
 * characters; a longer one, which neither provider writes, fails the page.
 * @param position The last session listed and each source's state.
 * @param filters The read's normalized folders, providers, search and continued filter.
 * @returns The cursor.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const encodeDiscoveryCursor = (position: IDiscoveryPosition, filters: object): string => {
  try {
    return discoveryCursors.encode(position, filters)!;
  } catch (cause) {
    if (!hasErrorCode(cause, 'CURSOR_TOO_LONG')) throw cause;
    throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' }, cause });
  }
};
