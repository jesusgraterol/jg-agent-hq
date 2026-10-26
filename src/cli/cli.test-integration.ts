// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { installCodexFixture, withClaudeRuntime } from '../../scripts/test-support/index.js';

test('dedicated CLI provider selection reads Claude capabilities and reports unavailable provider data', async () => {
  await withClaudeRuntime(async ({ stateRoot }) => {
    const run = promisify(execFile);
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const response = await run(
      process.execPath,
      [cli, 'usage', '--state-root', stateRoot, '--provider', 'claude'],
      { timeout: 5000 },
    );
    expect(JSON.parse(response.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: 'usage',
      result: { provider: 'claude', state: 'available' },
    });
    const capabilities = await run(
      process.execPath,
      [cli, 'capabilities', '--state-root', stateRoot, '--provider', 'claude'],
      { timeout: 5000 },
    );
    expect(JSON.parse(capabilities.stdout)).toMatchObject({
      kind: 'capabilities',
      result: {
        provider: 'claude',
        scope: { kind: 'provider' },
        operations: { steer: { state: 'unsupported' } },
      },
    });
    const unavailable = await run(
      process.execPath,
      [cli, 'usage', '--state-root', stateRoot, '--provider', 'unregistered-provider'],
      { timeout: 5000 },
    );
    expect(JSON.parse(unavailable.stdout)).toStrictEqual({
      schemaVersion: 1,
      kind: 'usage',
      result: {
        provider: 'unregistered-provider',
        state: 'unavailable',
        source: 'native',
        observedAt: null,
        ordinaryUsageAllowed: null,
        windows: [],
      },
    });
    await expect(
      run(
        process.execPath,
        [cli, 'usage', '--state-root', stateRoot, '--provider', '../provider'],
        { timeout: 5000 },
      ),
    ).rejects.toThrow();
  });
});

const runClient = (stateRoot: string, chunks: Buffer[], extra: string[] = []) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url)),
        'request',
        '--state-root',
        stateRoot,
        ...extra,
      ],
      { timeout: 5000, maxBuffer: 65_536 },
      (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }),
    );
    child.once('error', reject);
    // Rejected oversized input can close the pipe before the producer finishes writing.
    child.stdin!.on('error', () => undefined);
    for (const chunk of chunks) child.stdin!.write(chunk);
    child.stdin!.end();
  });

test('stdin actions preserve split UTF-8 and return receipts without exposing message bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-stdin-'));
  let runtime: Awaited<ReturnType<typeof createAgentHq>> | undefined;
  try {
    const bin = await installCodexFixture(root);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
    vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', root);
    runtime = await createAgentHq({ stateRoot: join(root, 'state'), allowedRoots: [root] });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('wrong response');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: root,
          name: 'stdin-check',
        },
      },
    });
    if (created.kind !== 'action') throw new Error('wrong response');
    const threadId = created.result.threadId!;
    const deadline = Date.now() + 3000;
    for (;;) {
      const thread = await runtime.request({ kind: 'managed-thread', threadId });
      if (thread.kind === 'managed-thread' && thread.result?.state === 'idle') break;
      if (Date.now() >= deadline) throw new Error('thread creation deadline exceeded');
      await wait(10);
    }
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const named = await promisify(execFile)(
      process.execPath,
      [cli, 'managed-thread-name', '--state-root', runtime.stateRoot, '--name', 'STDIN-CHECK'],
      { timeout: 5000 },
    );
    expect(JSON.parse(named.stdout)).toMatchObject({
      kind: 'managed-thread-name',
      result: { id: threadId, name: 'stdin-check' },
    });
    const suggested = await promisify(execFile)(
      process.execPath,
      [cli, 'suggest-thread-name', '--state-root', runtime.stateRoot, '--topic', 'Stdin check'],
      { timeout: 5000 },
    );
    expect(JSON.parse(suggested.stdout)).toMatchObject({
      kind: 'suggest-thread-name',
      result: { name: 'stdin-check-2' },
    });
    const text = 'Write café 😀';
    const actionId = randomUUID();
    const content = Buffer.from(
      JSON.stringify({
        kind: 'action',
        action: {
          id: actionId,
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'message', threadId, input: { kind: 'text', text: text } },
        },
      }),
    );
    const split = content.indexOf(Buffer.from('😀')) + 1;
    const result = await runClient(runtime.stateRoot, [
      content.subarray(0, split),
      content.subarray(split),
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: 'action',
      result: { id: actionId, delivery: 'submitted' },
    });
    expect(result.stdout).not.toContain(text);
    let found = false;
    for (let count = 0; count < 128 && !found; count += 1) {
      const calls = z.array(z.object({ method: z.string(), params: z.unknown() })).parse(
        (await readFile(join(root, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
      const call = calls.find((entry) => entry.method === 'turn/start');
      if (call) {
        expect(
          z
            .object({ input: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
            .parse(call.params).input,
        ).toStrictEqual([{ type: 'text', text }]);
        found = true;
      } else await wait(10);
    }
    expect(found).toBe(true);
  } finally {
    try {
      await runtime?.close();
      await rm(root, { recursive: true });
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

test.each([
  ['malformed UTF-8', Buffer.from([0xff]), []],
  ['oversized input', Buffer.alloc(65_537, 32), []],
  ['malformed JSON', Buffer.from('{'), []],
  ['unsupported command fields', Buffer.from('{"kind":"status","unexpected":true}'), []],
  ['extra target flags', Buffer.from('{"kind":"status"}'), ['--workspace-root', '/example']],
])('stdin rejects %s before native access', async (_label, content, extra) => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-invalid-stdin-'));
  try {
    const result = await runClient(join(root, 'state'), [content], extra);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toStrictEqual({
      schemaVersion: 1,
      success: false,
      error: { kind: 'invalid-request', message: 'Request is invalid.' },
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test('installed plan commands and stdin finalization work without a private plan registry', async () => {
  await withClaudeRuntime(async ({ stateRoot, workspaceRoot }) => {
    const directory = join(workspaceRoot, 'ordinary-plan');
    // jg-breakdown assigns the milestone ID that finalization requires
    const milestoneId = randomUUID();
    await mkdir(directory);
    await writeFile(join(directory, 'plan.md'), '# Plan\nBuild one feature.\n');
    await writeFile(
      join(directory, 'milestones.md'),
      `# Milestones\n\n## Milestone 1: Feature\n**Status:** pending\n**Milestone ID:** ${milestoneId}\n\n**Objective:** Build the feature.\n**Dependencies:** None.\n**Scope:** Feature.\n**Implementation:** Implement it.\n**Verification:** Real checks.\n**Acceptance:** Correct.\n**Review checkpoint:** Review it.\n`,
    );
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const run = promisify(execFile);
    const before = JSON.parse(
      (
        await run(process.execPath, [
          cli,
          'plan-status',
          '--state-root',
          stateRoot,
          '--directory',
          directory,
        ])
      ).stdout,
    );
    expect(before.result.result.state).toBe('plan-approval-required');
    const finalized = await runClient(stateRoot, [
      Buffer.from(
        JSON.stringify({
          kind: 'plan',
          command: {
            kind: 'finalize',
            target: { directory },
            action: {
              id: randomUUID(),
              operatorId: 'local-owner',
              source: { kind: 'user-message', reference: 'cli:explicit-finalize' },
            },
            expected: before.result.result.revision,
          },
        }),
      ),
    ]);
    expect(finalized.code).toBe(0);
    expect(JSON.parse(finalized.stdout).result.content).toContain(
      `**Milestone ID:** ${milestoneId}`,
    );
    const page = JSON.parse(
      (
        await run(process.execPath, [
          cli,
          'plan-milestones',
          '--state-root',
          stateRoot,
          '--directory',
          directory,
          '--limit',
          '1',
        ])
      ).stdout,
    );
    expect(page.result.result.data).toHaveLength(1);
    expect(page.result.result.nextCursor).toBeNull();
    await expect(
      run(process.execPath, [
        cli,
        'plan-milestones',
        '--state-root',
        stateRoot,
        '--directory',
        directory,
        '--limit',
        '129',
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Request is invalid.') });
  });
});

const runOffline = (args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url)), ...args],
      { timeout: 15000, maxBuffer: 65536, env: { ...process.env, PATH: '' } },
      (_error, stdout, stderr) => resolveResult({ code: child.exitCode, stdout, stderr }),
    );
    child.once('error', reject);
  });

// a stopped state root with a stamp from another package build, inspected without native binaries
const withWrittenState = async (
  stamp: string,
  run: (fixture: { root: string; stateRoot: string; workspaceRoot: string }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-cli-stamp-'));
  try {
    const stateRoot = join(root, 'state');
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    await runtime.close();
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      database.exec(stamp);
    } finally {
      database.close();
    }
    await run({ root, stateRoot, workspaceRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  [
    'a newer schema',
    `UPDATE hq_schema SET schema_hash = '${'0'.repeat(64)}', package_version = '9.9.9'`,
    'The HQ storage is invalid: written by jg-agent-hq 9.9.9',
  ],
  [
    'a stamp without a package version',
    'ALTER TABLE hq_schema DROP COLUMN package_version',
    'The HQ storage is invalid: written by another jg-agent-hq version',
  ],
])(
  'serve refuses storage from %s and names the version that wrote it',
  async (_label, stamp, message) => {
    await withWrittenState(stamp, async ({ root, stateRoot, workspaceRoot }) => {
      const result = await runOffline([
        'serve',
        '--state-root',
        stateRoot,
        '--workspace-root',
        workspaceRoot,
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toStrictEqual({
        schemaVersion: 1,
        success: false,
        error: { kind: 'state-conflict', message },
      });
      expect(result.stderr).not.toContain(root);
    });
  },
);

test('the CLI has no storage upgrade command or backup flag', async () => {
  expect((await runOffline(['--help'])).stdout).not.toContain('upgrade');
  for (const args of [
    ['upgrade-storage', '--state-root', 'state'],
    ['serve', '--state-root', 'state', '--backup-directory', 'backup'],
  ]) {
    const result = await runOffline(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ schemaVersion: 1, success: false });
  }
});
