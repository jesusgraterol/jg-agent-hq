import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, type IJsonValue } from 'jg-exception';
import { createCursorCodec, detectMediaType } from 'jg-utilities';
import { z } from 'zod';

import {
  ItemImageMediaTypeSchema,
  MAX_ITEM_IMAGE_BYTES,
  MAX_ITEM_TEXT_LENGTH,
  type IHistoryItem,
  type IItemImage,
  type IItemImageMediaType,
} from '../contracts/index.js';
import { HQ_ERRORS } from '../errors/index.js';

// the longest cursor a request accepts, as its CursorSchema bounds it
const MAX_CURSOR_LENGTH = 16_384;

// request schemas produce deterministic key ordering before filters are hashed
const hashFilters = (filters: object): string => hashValue(JSON.stringify(filters));

/**
 * Creates the cursors of one paged read. Each cursor carries a position, such as the last row's
 * ordering keys, bound to the hash of the request's filters, so it continues only the request it
 * came from. Authorization is checked separately.
 * @param position The schema of the read's position.
 * @returns The read's cursor codec.
 */
export const createRequestCursors = <TPosition extends { [key: string]: IJsonValue }>(
  position: z.ZodType<TPosition>,
) => {
  const codec = createCursorCodec<
    { filterHash: string; position: TPosition },
    { filterHash: string }
  >({
    schema: z.strictObject({ filterHash: z.string().regex(/^[a-f0-9]{64}$/), position }),
    maxLength: MAX_CURSOR_LENGTH,
  });
  return {
    /**
     * Encodes the position the next page starts at, bound to the request's filters.
     * @param next The position, or null when no page follows.
     * @param filters The request without its cursor.
     * @returns The cursor, or null for the last page.
     * @throws
     * - CURSOR_TOO_LONG: The cursor is longer than the codec's maximum length.
     */
    encode: (next: TPosition | null, filters: object): string | null =>
      next === null ? null : codec.encode({ filterHash: hashFilters(filters), position: next }),
    /**
     * Decodes a client's cursor for the request it must continue.
     * @param cursor The cursor, if any.
     * @param filters The request without its cursor.
     * @returns The position, or undefined for the first page.
     * @throws
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     */
    decode: (cursor: string | undefined, filters: object): TPosition | undefined => {
      try {
        return codec.decode(cursor, { filterHash: hashFilters(filters) })?.position;
      } catch (cause) {
        throw new Exception(`The HQ cursor does not match this request: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_CURSOR_INVALID',
          data: { kind: 'invalid-request' },
          cause,
        });
      }
    },
  };
};

// a provider's own continuation, which HQ passes back without interpreting it
const nativeCursors = createRequestCursors(
  z.strictObject({ nativeCursor: z.string().min(1).max(12_000) }),
);

/**
 * Checks query binding before a native continuation is used. Authorization is checked separately.
 * @returns The provider-owned cursor, without interpreting its format.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const decodeHistoryCursor = (
  cursor: string | undefined,
  filters: object,
): string | undefined => nativeCursors.decode(cursor, filters)?.nativeCursor;

/**
 * Encodes a validated native continuation with the exact request filters.
 * @throws
 * - CURSOR_TOO_LONG: The cursor is longer than the codec's maximum length.
 */
export const encodeHistoryCursor = (nativeCursor: string | null, filters: object): string | null =>
  nativeCursors.encode(nativeCursor === null ? null : { nativeCursor }, filters);

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

/**
 * Keeps a long output's last 65,536 UTF-16 code units, where its newest lines are, without
 * splitting a surrogate pair.
 * @param text The whole output.
 * @returns The kept text, and whether its start was cut.
 */
export const keepTextEnd = (text: string): { text: string; isStartCut: boolean } => {
  if (text.length <= MAX_ITEM_TEXT_LENGTH) return { text, isStartCut: false };
  const start = text.length - MAX_ITEM_TEXT_LENGTH;
  return {
    text: text.slice(/[\uDC00-\uDFFF]/.test(text.charAt(start)) ? start + 1 : start),
    isStartCut: true,
  };
};

/**
 * Presents a created or deleted file's content as a diff whose every line is added or removed.
 * @param content The file's content.
 * @param sign `+` for a created file, `-` for a deleted one.
 * @returns The unified diff hunk, empty for an empty file.
 */
export const toWholeFileDiff = (content: string, sign: '+' | '-'): string => {
  const count = countLines(content);
  if (count === 0) return '';
  const lines = content.split('\n').slice(0, count);
  const range = sign === '+' ? `-0,0 +1,${count}` : `-1,${count} +0,0`;
  return [`@@ ${range} @@`, ...lines.map((line) => `${sign}${line}`)].join('\n');
};

/**
 * Recognizes an image by its first bytes, never by a declared type.
 * @param head At least the image's first 12 bytes.
 * @returns The image's format, or null for anything else.
 */
export const toImageMediaType = (head: Uint8Array): IItemImageMediaType | null =>
  detectMediaType(head, ItemImageMediaTypeSchema.options);

/**
 * Describes an image an item holds as base64, decoding only its first bytes.
 * @param data The image's base64 text.
 * @returns Its format, or null when it isn't a recognized image, and its size in bytes.
 */
export const describeBase64Image = (
  data: string,
): { mediaType: IItemImageMediaType | null; byteCount: number } => ({
  mediaType: toImageMediaType(Buffer.from(data.slice(0, 16), 'base64')),
  byteCount: Buffer.byteLength(data, 'base64'),
});

/**
 * Refuses an image HQ doesn't return: one the item doesn't hold, one that isn't a recognized
 * image or is over 4 MiB, a file that is a symbolic link or not a regular file, or a URL.
 * @param cause The failure that made the image unreadable, when there is one.
 * @throws
 * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
 */
export const imageUnavailable = (cause?: unknown): never => {
  throw HQ_ERRORS.create('imageUnavailable', {
    data: { kind: 'image-unavailable' },
    ...(cause === undefined ? {} : { cause }),
  });
};

/**
 * Returns an image's bytes when they are a recognized image of at most 4 MiB.
 * @param bytes The image's bytes.
 * @returns The image, its format set by its first bytes.
 * @throws
 * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
 */
export const toItemImage = (bytes: Uint8Array): IItemImage => {
  const mediaType = bytes.length <= MAX_ITEM_IMAGE_BYTES ? toImageMediaType(bytes) : null;
  return mediaType
    ? {
        mediaType,
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      }
    : imageUnavailable();
};

/**
 * Decodes an image an item holds as base64, measuring it before decoding it.
 * @param data The image's base64 text.
 * @returns The image.
 * @throws
 * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
 */
export const decodeBase64Image = (data: string): IItemImage =>
  Buffer.byteLength(data, 'base64') <= MAX_ITEM_IMAGE_BYTES
    ? toItemImage(Buffer.from(data, 'base64'))
    : imageUnavailable();
