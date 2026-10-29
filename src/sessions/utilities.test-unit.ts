import { expect, test } from 'vitest';

import { keepTextEnd, toImageMediaType, toWholeFileDiff } from './utilities.js';

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
