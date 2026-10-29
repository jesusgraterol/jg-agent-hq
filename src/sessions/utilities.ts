import { createHash } from 'node:crypto';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import {
  MAX_ITEM_IMAGE_BYTES,
  MAX_ITEM_TEXT_LENGTH,
  type IHistoryItem,
  type IItemImage,
  type IItemImageMediaType,
} from '../contracts/index.js';

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
export const toImageMediaType = (head: Uint8Array): IItemImageMediaType | null => {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\u001a\n') return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
    return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
};

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
  throw new Exception('The HQ image is unavailable', {
    code: 'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
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
