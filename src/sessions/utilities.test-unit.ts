import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  createRequestCursors,
  decodeBase64Image,
  decodeHistoryCursor,
  encodeHistoryCursor,
  keepTextEnd,
  toImageMediaType,
  toItemImage,
  toWholeFileDiff,
} from './utilities.js';

test.each([
  ['an output at the limit', 'a'.repeat(65_536), 'a'.repeat(65_536), false],
  ['an output past the limit', `b${'a'.repeat(65_536)}`, 'a'.repeat(65_536), true],
  // the cut would leave the low half of an emoji's surrogate pair first, so it starts after it
  ['a surrogate pair at the cut', `😀${'a'.repeat(65_535)}`, 'a'.repeat(65_535), true],
])('keepTextEnd(%s)', (_case, text, kept, isStartCut) => {
  expect(keepTextEnd(text)).toStrictEqual({ text: kept, isStartCut });
});

test.each([
  ['a created file', 'one\ntwo\n', '+', '@@ -0,0 +1,2 @@\n+one\n+two'],
  ['a file without a final newline', 'one\ntwo', '+', '@@ -0,0 +1,2 @@\n+one\n+two'],
  ['a deleted file', 'gone\n', '-', '@@ -1,1 +0,0 @@\n-gone'],
  ['an empty file', '', '+', ''],
] as const)('toWholeFileDiff(%s)', (_case, content, sign, diff) => {
  expect(toWholeFileDiff(content, sign)).toBe(diff);
});

test.each([
  ['89504e470d0a1a0a0000000d', 'image/png'],
  ['ffd8ffe000104a4649460001', 'image/jpeg'],
  [Buffer.from('GIF87a').toString('hex'), 'image/gif'],
  [Buffer.from('GIF89a').toString('hex'), 'image/gif'],
  [Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP').toString('hex'), 'image/webp'],
  [Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE').toString('hex'), null],
  [Buffer.from('<svg xmlns=').toString('hex'), null],
  ['89504e47', null],
  ['', null],
])('toImageMediaType(%s) -> %s', (head, mediaType) => {
  expect(toImageMediaType(Buffer.from(head, 'hex'))).toBe(mediaType);
});

// a PNG signature followed by zeros, as large as a test needs
const png = (size: number) => {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return bytes;
};

test('toItemImage(a 4 MiB PNG) -> its base64 data', () => {
  const bytes = png(4_194_304);
  expect(toItemImage(bytes)).toStrictEqual({
    mediaType: 'image/png',
    data: bytes.toString('base64'),
  });
});

test.each([
  ['a PNG one byte over 4 MiB', png(4_194_305)],
  ['text', Buffer.from('not an image')],
  ['nothing', Buffer.alloc(0)],
])('toItemImage(%s) -> image-unavailable', (_case, bytes) => {
  expectToThrowCode(
    () => toItemImage(bytes),
    'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
    'The HQ image is unavailable',
  );
});

test('decodeBase64Image(a 4 MiB PNG) -> the image, and one byte more -> image-unavailable', () => {
  expect(decodeBase64Image(png(4_194_304).toString('base64')).mediaType).toBe('image/png');
  expectToThrowCode(
    () => decodeBase64Image(png(4_194_305).toString('base64')),
    'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
  );
});

// a read whose position is its last row's ordering keys, and another read's position
const pages = createRequestCursors(z.strictObject({ createdAt: z.number().int(), id: z.uuid() }));
const others = createRequestCursors(z.strictObject({ revision: z.string(), offset: z.number() }));
const filters = { kind: 'actions', threadId: '00000000-0000-4000-8000-000000000001', limit: 2 };
const position = { createdAt: 1_000, id: '00000000-0000-4000-8000-000000000002' };

// flips one character of a cursor's encoded JSON, keeping it valid base64url
const tamper = (cursor: string): string =>
  `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`;

test('a request cursor continues the request it came from at its position', () => {
  const cursor = pages.encode(position, filters)!;
  expect(pages.decode(cursor, { ...filters })).toStrictEqual(position);
  expect(pages.decode(undefined, filters)).toBeUndefined();
  expect(pages.encode(null, filters)).toBeNull();
  // the version a cursor once carried is gone; it holds only the filter hash and the position
  expect(Object.keys(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))).toStrictEqual([
    'filterHash',
    'position',
  ]);
});

test.each([
  [
    'another request',
    () => pages.decode(pages.encode(position, filters)!, { ...filters, limit: 3 }),
  ],
  ['a tampered cursor', () => pages.decode(tamper(pages.encode(position, filters)!), filters)],
  ['a malformed cursor', () => pages.decode('not a cursor', filters)],
  [
    "another read's cursor",
    () => pages.decode(others.encode({ revision: 'r', offset: 1 }, filters)!, filters),
  ],
  [
    'a position outside its schema',
    () =>
      pages.decode(
        Buffer.from(
          JSON.stringify({ filterHash: 'a'.repeat(64), position: { createdAt: 1, id: 'x' } }),
        ).toString('base64url'),
        filters,
      ),
  ],
  ['a cursor longer than a request accepts', () => pages.decode('A'.repeat(16_385), filters)],
])('a request cursor from %s fails with CURSOR_INVALID', (_case, decode) => {
  expectToThrowCode(
    decode,
    'JG_AGENT_HQ_CURSOR_INVALID',
    'The HQ cursor does not match this request',
  );
});

test('a native cursor passes the provider continuation back only to the request it came from', () => {
  const cursor = encodeHistoryCursor('native-page-2', filters)!;
  expect(decodeHistoryCursor(cursor, filters)).toBe('native-page-2');
  expect(encodeHistoryCursor(null, filters)).toBeNull();
  expectToThrowCode(
    () => decodeHistoryCursor(cursor, { ...filters, limit: 3 }),
    'JG_AGENT_HQ_CURSOR_INVALID',
  );
  expectToThrowCode(
    () => decodeHistoryCursor(tamper(cursor), filters),
    'JG_AGENT_HQ_CURSOR_INVALID',
  );
  expectToThrowCode(
    () => decodeHistoryCursor(pages.encode(position, filters)!, filters),
    'JG_AGENT_HQ_CURSOR_INVALID',
  );
});
