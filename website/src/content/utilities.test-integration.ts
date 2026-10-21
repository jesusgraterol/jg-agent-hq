// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { readDocument } from './index.ts';

test('reads only the exact bounded regular canonical sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hq-site-source-'));
  try {
    await writeFile(join(root, 'README.md'), '# Canonical\n');
    expect(await readDocument(root, 'README.md')).toBe('# Canonical\n');
    await expectToRejectCode(
      readDocument(root, 'api/README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await expectToRejectCode(
      readDocument(root, '../README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await writeFile(join(root, 'README.md'), Buffer.alloc(1048576, 97));
    expect((await readDocument(root, 'README.md')).length).toBe(1048576);
    await writeFile(join(root, 'README.md'), Buffer.alloc(1048577, 97));
    await expectToRejectCode(
      readDocument(root, 'README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await writeFile(join(root, 'README.md'), Buffer.from([0xff]));
    await expectToRejectCode(
      readDocument(root, 'README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await rm(join(root, 'README.md'));
    await mkdir(join(root, 'README.md'));
    await expectToRejectCode(
      readDocument(root, 'README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await rm(join(root, 'README.md'), { recursive: true });
    await writeFile(join(root, 'target.md'), '# Unselected');
    await symlink(join(root, 'target.md'), join(root, 'README.md'));
    await expectToRejectCode(
      readDocument(root, 'README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
