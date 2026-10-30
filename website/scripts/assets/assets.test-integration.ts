// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { generateAssets } from './assets.ts';

test(
  'reproduces committed assets through Chromium and closes after a write failure',
  { tags: ['full'] },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hq-site-assets-'));
    try {
      const blocked = join(root, 'blocked');
      await writeFile(blocked, 'occupied');
      await expectToRejectCode(
        generateAssets(blocked),
        'JG_AGENT_HQ_WEBSITE_ASSETS_FAILED',
        'The HQ website assets could not be generated',
      );
      const output = join(root, 'public');
      await generateAssets(output);
      for (const path of [
        'favicon.ico',
        'favicons/32x32.png',
        'favicons/192x192.png',
        'og/jg-agent-hq.png',
      ]) {
        expect(await readFile(join(output, path))).toStrictEqual(
          await readFile(new URL(`../../public/${path}`, import.meta.url)),
        );
      }
      const ico = await readFile(join(output, 'favicon.ico'));
      expect(ico.readUInt16LE(2)).toBe(1);
      expect(ico.readUInt16LE(4)).toBe(3);
      expect([ico[6], ico[22], ico[38]]).toStrictEqual([16, 32, 48]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
