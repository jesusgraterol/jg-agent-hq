import { gzipSync, gunzipSync } from 'node:zlib';
import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { buildArchive, type IArchiveFile } from '../testing/index.ts';

import { samePublishedArchive } from './archive.ts';

const files: IArchiveFile[] = [
  { name: 'package/package.json', content: '{"name":"fixture","scripts":{"test":"complete"}}' },
  { name: 'package/README.md', content: '# Package\n\n## Usage\nProtected.\n' },
  { name: 'package/dist/index.js', content: 'export const result = 1;\n' },
];

test('entry order and compression do not hide changed protected file bytes or modes', () => {
  expect(samePublishedArchive(buildArchive(files), buildArchive([...files].reverse()))).toBe(true);
  for (const changed of [
    [...files.slice(0, 2), { ...files[2]!, content: 'changed runtime' }],
    [...files.slice(0, 2), { ...files[2]!, mode: 0o755 }],
    [...files, { name: 'package/extra.js', content: 'added' }],
    files.slice(0, 2),
  ])
    expect(samePublishedArchive(buildArchive(files), buildArchive(changed))).toBe(false);
});

test('only aggregate scripts and a marked README testing block may differ', () => {
  const candidate = [
    {
      ...files[0]!,
      content: '{"name":"fixture","scripts":{"test":"essential","test:full":"complete"}}',
    },
    {
      ...files[1]!,
      content:
        '# Package\n\n[testing-commands:start]: #\nTests.\n[testing-commands:end]: #\n\n## Usage\nProtected.\n',
    },
    files[2]!,
  ];
  expect(samePublishedArchive(buildArchive(files), buildArchive(candidate))).toBe(true);
  expect(
    samePublishedArchive(
      buildArchive(files),
      buildArchive([candidate[0]!, { ...candidate[1]!, mode: 0o755 }, candidate[2]!]),
    ),
  ).toBe(false);
});

test.each([
  ['traversal', [{ name: 'package/../private', content: 'unsafe' }]],
  ['absolute path', [{ name: '/package/private', content: 'unsafe' }]],
  ['backslash', [{ name: 'package/a\\b', content: 'unsafe' }]],
  ['symlink', [{ name: 'package/link', content: '', type: '2' }]],
  ['hardlink', [{ name: 'package/link', content: '', type: '1' }]],
  ['extension record', [{ name: 'package/pax', content: '', type: 'x' }]],
  ['duplicate', [files[2]!]],
])('rejects %s before metadata comparison', (_label, additional) => {
  expectToThrowCode(
    () => samePublishedArchive(buildArchive(files), buildArchive([...files, ...additional])),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
  );
});

test('rejects corrupt checksums, incomplete bodies/endings, trailing data and missing identity files', () => {
  const valid = buildArchive(files);
  const tar = gunzipSync(valid);
  const corrupt = Buffer.from(tar);
  corrupt[0] = 0;
  for (const bytes of [
    gzipSync(corrupt),
    gzipSync(tar.subarray(0, 600)),
    gzipSync(tar.subarray(0, -1024)),
    gzipSync(Buffer.concat([tar, Buffer.from('hidden')])),
    buildArchive(files.slice(1)),
    buildArchive([files[0]!, files[2]!]),
  ])
    expectToThrowCode(() => samePublishedArchive(valid, bytes), 'JG_AGENT_HQ_RELEASE_CHECK_FAILED');
});

test('bounds compressed bytes, expanded bytes and entry count', () => {
  const valid = buildArchive(files);
  const many = Array.from({ length: 4096 }, (_, index) => ({
    name: `package/file-${index}.js`,
    content: '',
  }));
  for (const bytes of [
    Buffer.alloc(16 * 1024 * 1024 + 1),
    gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)),
    buildArchive([...files, ...many]),
  ])
    expectToThrowCode(() => samePublishedArchive(valid, bytes), 'JG_AGENT_HQ_RELEASE_CHECK_FAILED');
});
