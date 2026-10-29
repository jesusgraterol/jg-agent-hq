import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import {
  decodeBase64Image,
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

test('toItemImage(an 8 MiB PNG) -> its base64 data', () => {
  const bytes = png(8_388_608);
  expect(toItemImage(bytes)).toStrictEqual({
    mediaType: 'image/png',
    data: bytes.toString('base64'),
  });
});

test.each([
  ['a PNG one byte over 8 MiB', png(8_388_609)],
  ['text', Buffer.from('not an image')],
  ['nothing', Buffer.alloc(0)],
])('toItemImage(%s) -> image-unavailable', (_case, bytes) => {
  expectToThrowCode(
    () => toItemImage(bytes),
    'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
    'The HQ image is unavailable',
  );
});

test('decodeBase64Image(an 8 MiB PNG) -> the image, and one byte more -> image-unavailable', () => {
  expect(decodeBase64Image(png(8_388_608).toString('base64')).mediaType).toBe('image/png');
  expectToThrowCode(
    () => decodeBase64Image(png(8_388_609).toString('base64')),
    'JG_AGENT_HQ_IMAGE_UNAVAILABLE',
  );
});
