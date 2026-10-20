// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { installCodexFixture } from '../test-support/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PackedResult = z.array(
  z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) }),
);

// packing and a cold npm install each have their own 60-second process deadline
test(
  'the actual tarball exposes only the built public API and works in an isolated consumer',
  { timeout: 150_000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'jg-hq-package-'));
    try {
      const stdout = execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 2_097_152,
        },
      );
      const [packed] = PackedResult.parse(JSON.parse(stdout));
      if (!packed) throw new Error('npm produced no package');
      const paths = packed.files.map(({ path }) => path);
      expect(paths).toContain('dist/index.js');
      expect(paths).toContain('dist/index.d.ts');
      expect(paths).toContain('dist/cli/cli.js');
      expect(paths).toContain('dist/store/schema.sql');
      expect(paths).toContain('dist/contracts/index.js');
      expect(paths).toContain('LICENSE');
      expect(
        paths.filter((path) => /(?:test-|node_modules|website|\.runtime|\.map$)/.test(path)),
      ).toStrictEqual([]);
      expect(
        paths.every(
          (path) =>
            path.startsWith('dist/') ||
            [
              'package.json',
              'README.md',
              'LICENSE',
              'CHANGELOG.md',
              'api/README.md',
              'errors/README.md',
            ].includes(path),
        ),
      ).toBe(true);
      await writeFile(
        join(scratch, 'package.json'),
        JSON.stringify({ private: true, type: 'module' }),
      );
      execFileSync(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          join(scratch, packed.filename),
        ],
        {
          cwd: scratch,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 2_097_152,
        },
      );
      const script = `
      import { createAgentHq, requestAgentHq, withHqLock, readHqLockState } from 'jg-agent-hq';
      import { HqResponseSchema } from 'jg-agent-hq/contracts';
      import { join } from 'node:path';
      const stateRoot = join(process.cwd(), 'state');
      const value = await withHqLock(stateRoot, 'smoke', async () => 42);
      if (value !== 42 || (await readHqLockState(stateRoot)).kind !== 'free') throw new Error('consumer failed');
      try { await import('jg-agent-hq/dist/locks/locks.js'); throw new Error('private path was exposed'); }
      catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
      const runtime = await createAgentHq({ stateRoot: join(process.cwd(), 'controller'), allowedRoots: [process.cwd()] });
      try {
        const response = HqResponseSchema.parse(await requestAgentHq(runtime.stateRoot, { kind: 'threads', provider: 'codex', workspaceRoot: process.cwd(), limit: 1 }));
        if (response.kind !== 'threads' || response.result.data.length !== 1) throw new Error('packed runtime failed');
      } finally { await runtime.close(); }
    `;
      const bin = await installCodexFixture(scratch);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        JG_HQ_FIXTURE_DIRECTORY: scratch,
        JG_HQ_FIXTURE_WORKSPACE: scratch,
      };
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 65_536,
      });
      const help = execFileSync(join(scratch, 'node_modules/.bin/jg-agent-hq'), ['--help'], {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(help).toContain('serve|status|stop|threads|thread|turns|items|usage');
      const contracts = await readdir(join(ROOT, 'dist/contracts'));
      for (const filename of contracts.filter((filename) => filename.endsWith('.js'))) {
        const source = await readFile(join(ROOT, 'dist/contracts', filename), 'utf8');
        const imports = Array.from(
          source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g),
          (match) => match[1],
        );
        expect(
          imports.every(
            (specifier) =>
              specifier === 'zod' ||
              (specifier.startsWith('./') && !specifier.slice(2).includes('/')),
          ),
        ).toBe(true);
      }
      expect((await readdir(join(ROOT, 'dist/locks'))).some((name) => name.includes('test-'))).toBe(
        false,
      );
      const declarations = await readFile(join(ROOT, 'dist/index.d.ts'), 'utf8');
      expect(declarations).not.toContain(".ts'");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
