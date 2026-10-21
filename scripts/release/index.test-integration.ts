import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { ReleaseManifestSchema } from './types.ts';

test('the publishing entry rejects a changed downloaded archive before contacting npm', async () => {
  const directory = join(tmpdir(), `hq-release-${randomUUID()}`);
  await mkdir(directory);
  try {
    const manifest = ReleaseManifestSchema.parse(
      JSON.parse(await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')),
    );
    const archive = join(directory, `jg-agent-hq-${manifest.version}.tgz`);
    await writeFile(archive, 'changed archive');
    await writeFile(`${archive}.sha512`, 'sha512-original\n');
    await expect(
      promisify(execFile)(process.execPath, [resolve(import.meta.dirname, 'index.ts')], {
        env: { ...process.env, JG_HQ_RELEASE_DIRECTORY: directory },
        timeout: 5000,
        maxBuffer: 65536,
      }),
    ).rejects.toThrow('the downloaded archive checksum does not match the tested archive');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
