// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { hashValue } from 'jg-crypto';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { installCodexFixture } from '../test-support/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PackedResult = z.array(
  z.object({
    filename: z.string(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
    files: z.array(z.object({ path: z.string() })),
  }),
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
      expect(paths.filter((path) => path.startsWith('dist/storage/'))).not.toContainEqual(
        expect.stringMatching(/v1|upgrade/),
      );
      expect(paths).toContain('dist/contracts/index.js');
      expect(paths).toContain('dist/agent-tools/mcp/mcp.js');
      expect(paths).toContain('LICENSE');
      expect(paths).toContain('docs/recovery.md');
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
              'docs/recovery.md',
            ].includes(path),
        ),
      ).toBe(true);
      expect(paths.some((path) => path.startsWith('examples/'))).toBe(false);
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
      for (const asset of ['store/schema.sql'])
        expect(
          hashValue(await readFile(join(scratch, 'node_modules/jg-agent-hq/dist', asset))),
        ).toBe(hashValue(await readFile(join(ROOT, 'src', asset))));
      const sourceExamples = [
        'control-session.ts',
        'review-handoff.ts',
        'revise-plan.ts',
        'shared-storage.ts',
      ];
      await mkdir(join(scratch, 'examples'));
      for (const example of sourceExamples)
        await copyFile(join(ROOT, 'examples', example), join(scratch, 'examples', example));
      const usageContract = join(scratch, 'usage-contract.ts');
      await writeFile(
        usageContract,
        `import type { IAgentProvider } from 'jg-agent-hq';
import type { IUsageCredits, IUsageResetCredits, IUsageWindowScope } from 'jg-agent-hq/contracts';
export const legacyReadUsage: IAgentProvider['readUsage'] = async () => ({
  provider: 'older-provider', source: 'native', state: 'unavailable', observedAt: null,
  ordinaryUsageAllowed: null, windows: [],
});
export const credit: IUsageCredits = { bucket: 'older-provider', hasCredits: true, isUnlimited: false, balance: '0.29000000000000001' };
export const resets: IUsageResetCredits = { availableCount: 0 };
export const scope: IUsageWindowScope = { model: { id: null, displayName: 'Model' }, surface: null };
`,
      );
      const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
      expect(config.error).toBeUndefined();
      const development = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
      const program = ts.createProgram(
        [...sourceExamples.map((example) => join(scratch, 'examples', example)), usageContract],
        {
          ...development.options,
          typeRoots: [join(ROOT, 'node_modules/@types')],
          noEmit: true,
        },
      );
      expect(
        ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => scratch,
          getNewLine: () => '\n',
        }),
      ).toBe('');
      const script = `
      import * as packed from 'jg-agent-hq';
      import { createAgentHq, requestAgentHq, withHqLock, readHqLockState } from 'jg-agent-hq';
      if ('upgradeHqStorage' in packed) throw new Error('packed storage upgrade remains');
      import { HqResponseSchema, BrowserActionSchema, UsageCreditsSchema, UsageResetCreditsSchema, UsageWindowScopeSchema } from 'jg-agent-hq/contracts';
      const credit = UsageCreditsSchema.parse({bucket:'codex',hasCredits:true,isUnlimited:false,balance:'0.29000000000000001'});
      if(credit.balance!=='0.29000000000000001') throw new Error('packed credit precision failed');
      UsageResetCreditsSchema.parse({availableCount:0});
      UsageWindowScopeSchema.parse({model:{id:null,displayName:'Model'},surface:null});
      import { controlSession } from './examples/control-session.ts';
      import { shareStorage } from './examples/shared-storage.ts';
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
        const status = await runtime.request({kind:'status'});
        const input = BrowserActionSchema.parse({id:crypto.randomUUID(),runtimeEpoch:status.result.runtimeEpoch,command:{kind:'publication-retry',publicationId:crypto.randomUUID(),expectedCommit:null}});
        let effects = 0;
        await runtime.performBrowserAction(input,'packed-operator',async()=>{effects++;});
        await runtime.performBrowserAction(input,'packed-operator',async()=>{effects++;});
        if(effects!==1 || (await runtime.readBrowserAction(input.id,'packed-operator')).state!=='acknowledged') throw new Error('packed receipt failed');
        const recovered = await shareStorage({hq: runtime,label:'Packed host preference.',snapshotDirectory:join(process.cwd(),'snapshot'),recoveryDirectory:join(process.cwd(),'recovery')});
        if(recovered.label!=='Packed host preference.' || recovered.snapshot.pendingWriteCount!==0) throw new Error('packed shared storage failed');
        const session = await controlSession({stateRoot: runtime.stateRoot, workspaceRoot: process.cwd(), provider: 'codex', name: 'packed-example', text: 'Discuss the task without changing files.', actionIds: {create:crypto.randomUUID(), message:crypto.randomUUID()}});
        if(session.receipt.delivery!=='acknowledged' || session.thread.provider!=='codex' || session.usage.source!=='native') throw new Error('packed source example failed');
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
      expect(help).toContain(
        'serve|status|stop|capabilities|threads|thread|turns|items|sessions|session-evidence|usage',
      );
      expect(help).not.toContain('upgrade');
      const installedManifest = JSON.parse(
        await readFile(join(scratch, 'node_modules/jg-agent-hq/package.json'), 'utf8'),
      ) as { dependencies: Record<string, string> };
      expect(installedManifest.dependencies['@modelcontextprotocol/server']).toBe('2.3.1');
      const bridge = spawnSync(
        process.execPath,
        [join(scratch, 'node_modules/jg-agent-hq/dist/cli/cli.js'), 'agent-bridge'],
        {
          cwd: scratch,
          env: { ...env, JG_AGENT_HQ_BRIDGE_FILE: join(scratch, 'missing-credential.json') },
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 65_536,
        },
      );
      expect(bridge.error).toBeUndefined();
      expect(bridge.status).toBe(1);
      expect(bridge.stdout).toBe('');
      expect(JSON.parse(bridge.stderr)).toMatchObject({
        success: false,
        error: { kind: 'access-denied' },
      });
      const contractRoot = join(ROOT, 'dist/contracts');
      const pending = [join(contractRoot, 'index.js')];
      const visited = new Set<string>();
      while (pending.length) {
        const filename = pending.pop()!;
        if (visited.has(filename)) continue;
        visited.add(filename);
        const source = ts.createSourceFile(
          filename,
          await readFile(filename, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const inspect = (node: ts.Node): void => {
          const specifier =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                ? node.arguments[0]
                : undefined;
          if (specifier) {
            expect(ts.isStringLiteral(specifier)).toBe(true);
            if (ts.isStringLiteral(specifier) && specifier.text !== 'zod') {
              expect(specifier.text.startsWith('.')).toBe(true);
              const target = resolve(dirname(filename), specifier.text);
              const local = relative(contractRoot, target);
              expect(
                !isAbsolute(local) &&
                  local !== '..' &&
                  !local.startsWith('../') &&
                  !local.startsWith('..\\'),
              ).toBe(true);
              expect(
                local
                  .split(/[\\/]/)
                  .some((part) => ['_archive', '_archives', '_backup', '_backups'].includes(part)),
              ).toBe(false);
              expect(target.endsWith('.js')).toBe(true);
              pending.push(target);
            }
          }
          ts.forEachChild(node, inspect);
        };
        inspect(source);
      }
      expect(visited.size).toBeGreaterThan(1);
      expect((await readdir(join(ROOT, 'dist/locks'))).some((name) => name.includes('test-'))).toBe(
        false,
      );
      const declarations = await readFile(join(ROOT, 'dist/index.d.ts'), 'utf8');
      expect(declarations).not.toContain(".ts'");
      // CI retains the exact consumer-tested archive for the separate trusted publisher.
      const releaseDirectory = process.env.JG_HQ_RELEASE_DIRECTORY;
      if (releaseDirectory) {
        await mkdir(releaseDirectory, { recursive: true });
        await copyFile(join(scratch, packed.filename), join(releaseDirectory, packed.filename));
        await writeFile(
          join(releaseDirectory, `${packed.filename}.sha512`),
          `${packed.integrity}\n`,
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
