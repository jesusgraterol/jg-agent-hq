// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { verifyBuild } from './index.ts';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

test('verifies the actual production artifact', { tags: ['full'] }, async () => {
  expect(await verifyBuild(DIST)).toMatchObject({ pages: 5 });
});

test.each([
  ['canonical', 'index.html', 'rel="canonical"', 'rel="missing"'],
  ['anchor', 'docs/index.html', '#claude-history', '#missing-heading'],
  ['Markdown', 'docs/index.md', '# jg-agent-hq', '# Different content'],
  ['404 indexing', '404.html', 'noindex, follow', 'index, follow'],
  ['discovery', 'sitemap-0.xml', '/docs/api/', '/unknown/'],
  [
    'example source',
    'examples/index.md',
    'Codex installed and signed in',
    'Silently retry actions',
  ],
  [
    'removed Markdown section',
    'index.html',
    'Running in three commands.',
    'Read this page as Markdown',
  ],
  ['asset', 'index.html', '/favicon.ico', '/missing.ico'],
])(
  'rejects damaged %s in real built output',
  { tags: ['full'] },
  async (_description, path, before, after) => {
    const root = await mkdtemp(join(tmpdir(), 'hq-site-build-'));
    try {
      await cp(DIST, root, { recursive: true });
      const file = join(root, path);
      const body = await readFile(file, 'utf8');
      expect(body).toContain(before);
      await writeFile(file, body.replaceAll(before, after));
      await expectToRejectCode(
        verifyBuild(root),
        'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        'The HQ website build is invalid',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('rejects leaked tests and private paths in real built output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hq-site-build-'));
  try {
    await cp(DIST, root, { recursive: true });
    await writeFile(join(root, 'leak.test-unit.ts'), 'test');
    await expectToRejectCode(
      verifyBuild(root),
      'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      'The HQ website build is invalid',
    );
    await rm(join(root, 'leak.test-unit.ts'));
    await writeFile(join(root, 'asset.js'), 'const source = "/home/local/private";');
    await expectToRejectCode(
      verifyBuild(root),
      'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      'The HQ website build is invalid',
    );
    await rm(join(root, 'asset.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects wrong image dimensions', { tags: ['full'] }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hq-site-build-'));
  try {
    await cp(DIST, root, { recursive: true });
    const png = await readFile(join(root, 'og/jg-agent-hq.png'));
    png.writeUInt32BE(800, 16);
    await writeFile(join(root, 'og/jg-agent-hq.png'), png);
    await expectToRejectCode(
      verifyBuild(root),
      'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      'The HQ website build is invalid',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
