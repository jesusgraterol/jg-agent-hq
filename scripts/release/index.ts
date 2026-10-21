import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Exception } from 'error-message-utils';

import { needsPublication, waitForPublication } from './release.ts';
import { ReleaseManifestSchema } from './types.ts';

const root = resolve(import.meta.dirname, '../..');
const manifest = ReleaseManifestSchema.parse(
  JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
);
const directory = process.env.JG_HQ_RELEASE_DIRECTORY;
if (!directory) throw new Exception('The HQ package release check failed');
const archive = resolve(directory, `jg-agent-hq-${manifest.version}.tgz`);
const archiveStat = await stat(archive);
if (!archiveStat.isFile() || archiveStat.size > 16777216)
  throw new Exception('The HQ package release check failed');
const integrity = `sha512-${createHash('sha512')
  .update(await readFile(archive))
  .digest('base64')}`;
if (
  (await stat(`${archive}.sha512`)).size > 128 ||
  (await readFile(`${archive}.sha512`, 'utf8')).trim() !== integrity
)
  throw new Exception(
    'The HQ package release check failed: the downloaded archive checksum does not match the tested archive',
  );
if (await needsPublication(manifest.version, integrity)) {
  // submit exactly once; an interrupted or failed acknowledgement stops the job for inspection
  const result = await promisify(execFile)(
    'npm',
    ['publish', archive, '--access', 'public', '--provenance', '--ignore-scripts'],
    { cwd: root, timeout: 60000, maxBuffer: 1048576 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  await waitForPublication(manifest.version, integrity);
} else {
  process.stdout.write(`jg-agent-hq@${manifest.version} already contains this verified archive.\n`);
}
