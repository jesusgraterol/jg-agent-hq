// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { z } from 'zod';

// a child runner deliberately times out; its next test must see completed fixture teardown
const TIMEOUT_SCENARIO = `
import { lstat, rm } from 'node:fs/promises';
import { afterAll, expect, test, vi } from 'vitest';
import { withClaudeRuntime, type IClaudeFixture } from './claude-runtime.js';
const path = process.env.PATH;
let first: IClaudeFixture | undefined;
afterAll(async () => {
  if (first) {
    await first.runtime.close();
    await expect(lstat(first.stateRoot + '/hq-owner.json')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(first.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
test('intentional timeout', { timeout: 2000 }, async () => {
  await withClaudeRuntime(async (fixture) => {
    first = fixture;
    await new Promise<void>(() => {});
  });
});
test('next fixture is isolated', async () => {
  expect(first).toBeDefined();
  expect(process.env.PATH).toBe(path);
  await expect(lstat(first!.root)).rejects.toMatchObject({ code: 'ENOENT' });
  await withClaudeRuntime(async ({ request }) => {
    const response = await request({ kind: 'usage', provider: 'claude' });
    expect(response.kind === 'usage' && response.result.state).toBe('available');
  });
});
`;

const ReportSchema = z.object({
  numFailedTests: z.number(),
  numPassedTests: z.number(),
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({
          title: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()),
        }),
      ),
    }),
  ),
});

test(
  'a timed-out fixture cannot restore environment or retain native ownership in the next test',
  {
    // the child runner includes an intentional timeout and two real native-fixture lifecycles
    timeout: 30_000,
  },
  async () => {
    const identity = randomBytes(8).toString('hex');
    const root = resolve(import.meta.dirname, '../..');
    const directory = join(tmpdir(), `jg-hq-timeout-${identity}`);
    const casePath = join(import.meta.dirname, `timeout-${identity}.test-integration.ts`);
    const reportPath = join(directory, 'report.json');
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(casePath, TIMEOUT_SCENARIO);
      let exitCode = 0;
      try {
        await promisify(execFile)(
          process.execPath,
          [
            join(root, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            'vitest/test-integration.config.ts',
            casePath,
            '--retry=0',
            '--reporter=json',
            '--outputFile',
            reportPath,
          ],
          { cwd: root, timeout: 20_000, maxBuffer: 1_048_576 },
        );
      } catch (cause) {
        expect(cause).toMatchObject({ code: 1 });
        exitCode = 1;
      }
      expect(exitCode).toBe(1);
      const report = ReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
      expect([report.numFailedTests, report.numPassedTests]).toStrictEqual([1, 1]);
      const cases = report.testResults.flatMap((result) => result.assertionResults);
      expect(cases.map((entry) => [entry.title, entry.status])).toStrictEqual([
        ['intentional timeout', 'failed'],
        ['next fixture is isolated', 'passed'],
      ]);
      expect(cases[0]!.failureMessages.join('\n')).toContain('timed out');
    } finally {
      await rm(casePath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
