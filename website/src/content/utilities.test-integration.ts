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
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'README.md'), '# Repository index\n');
    await expectToRejectCode(readDocument(root, 'README.md'), 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID');
    await writeFile(join(root, 'docs/getting-started.md'), '# Canonical\n');
    expect(await readDocument(root, 'docs/getting-started.md')).toBe('# Canonical\n');
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
    await writeFile(join(root, 'docs/getting-started.md'), '');
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    );
    await writeFile(join(root, 'docs/getting-started.md'), Buffer.alloc(1048576, 97));
    expect((await readDocument(root, 'docs/getting-started.md')).length).toBe(1048576);
    await writeFile(join(root, 'docs/getting-started.md'), Buffer.alloc(1048577, 97));
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await writeFile(join(root, 'docs/getting-started.md'), Buffer.from([0xff]));
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await rm(join(root, 'docs/getting-started.md'));
    await mkdir(join(root, 'docs/getting-started.md'));
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await rm(join(root, 'docs/getting-started.md'), { recursive: true });
    await writeFile(join(root, 'target.md'), '# Unselected');
    await symlink(join(root, 'target.md'), join(root, 'docs/getting-started.md'));
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
    await rm(join(root, 'docs/getting-started.md'));
    await rm(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'alternate'));
    await writeFile(join(root, 'alternate/getting-started.md'), '# Unselected parent');
    await symlink(join(root, 'alternate'), join(root, 'docs'));
    await expectToRejectCode(
      readDocument(root, 'docs/getting-started.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    );
    await mkdir(join(root, 'api'));
    await writeFile(join(root, 'api/README.md'), '# API\n');
    expect(await readDocument(root, 'api/README.md')).toBe('# API\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
