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

import {
  claudeRecord,
  installCodexFixture,
  withClaudeRuntime,
} from '../../scripts/test-support/index.js';

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

test('session-states reads transitions after a sequence through the installed command', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'cli-states' },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const run = promisify(execFile);
    const read = async (...args: string[]) =>
      JSON.parse(
        (await run(process.execPath, [cli, 'session-states', '--state-root', stateRoot, ...args]))
          .stdout,
      );
    await expect.poll(async () => (await read()).result.data.length).toBe(1);
    const first = await read('--limit', '1');
    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: 'session-states',
      result: {
        data: [{ threadId: created.result.threadId, state: 'idle', reason: 'opened' }],
        hasMore: false,
      },
    });
    expect(
      await read('--after-sequence', String(first.result.data[0].sequence), '--limit', '1'),
    ).toStrictEqual({
      schemaVersion: 1,
      kind: 'session-states',
      result: { data: [], hasMore: false },
    });
    await expect(
      run(process.execPath, [
        cli,
        'session-states',
        '--state-root',
        stateRoot,
        '--provider',
        'codex',
      ]),
    ).rejects.toThrow();
  });
});

test('active-sessions and observation-pace work through the installed command', async () => {
  await withClaudeRuntime(async ({ stateRoot }) => {
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const run = promisify(execFile);
    const read = async (...args: string[]) =>
      JSON.parse((await run(process.execPath, [cli, ...args, '--state-root', stateRoot])).stdout);
    expect(await read('active-sessions')).toStrictEqual({
      schemaVersion: 1,
      kind: 'active-sessions',
      result: { data: [], isTruncated: false },
    });
    for (const pace of ['live', 'background'])
      expect(await read('observation-pace', '--pace', pace)).toStrictEqual({
        schemaVersion: 1,
        kind: 'observation-pace',
        result: { pace },
      });
    for (const args of [
      ['observation-pace', '--pace', 'fast'],
      ['observation-pace'],
      ['active-sessions', '--limit', '1'],
      ['threads', '--pace', 'live'],
    ])
      await expect(read(...args)).rejects.toThrow();
  });
});

test('item-detail and item-image read one item through the installed command', async () => {
  await withClaudeRuntime(async ({ stateRoot, workspaceRoot, transcript }) => {
    const cli = fileURLToPath(new URL('../../dist/cli/cli.js', import.meta.url));
    const run = promisify(execFile);
    const read = async (...args: string[]) =>
      JSON.parse((await run(process.execPath, [cli, ...args, '--state-root', stateRoot])).stdout);
    const nativeId = randomUUID();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const prompt = {
      ...claudeRecord(workspaceRoot, nativeId),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'List the files' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      },
    };
    const call = {
      ...claudeRecord(workspaceRoot, nativeId, { type: 'assistant', parentUuid: prompt.uuid }),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }],
      },
    };
    await writeFile(
      transcript(nativeId),
      [prompt, call].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const target = [
      'item-detail',
      '--provider',
      'claude',
      '--workspace-root',
      workspaceRoot,
      '--native-id',
      nativeId,
    ];
    expect(
      await read(...target, '--turn-id', prompt.uuid, '--native-item-id', call.uuid),
    ).toMatchObject({
      schemaVersion: 1,
      kind: 'item-detail',
      result: {
        item: { nativeId: call.uuid, kind: 'tool' },
        command: { command: 'ls', output: null },
        tool: null,
      },
    });
    // one item is read only within its turn
    await expect(read(...target, '--native-item-id', call.uuid)).rejects.toThrow();
    const image = [
      'item-image',
      ...target.slice(1),
      '--turn-id',
      prompt.uuid,
      '--native-item-id',
      prompt.uuid,
    ];
    expect(await read(...image, '--index', '0')).toStrictEqual({
      schemaVersion: 1,
      kind: 'item-image',
      result: { mediaType: 'image/png', data: png },
    });
    await expect(read(...image, '--index', '1')).rejects.toThrow();
    await expect(read(...image, '--index', '64')).rejects.toThrow();
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
    // the hash of the schema jg-agent-hq 4.0.2 wrote, whose entry index had no notice kind
    'the 4.0.2 schema',
    "UPDATE hq_schema SET schema_hash = '062346e252b338d94d126c3f55f50851e003691b1be51de46b6e43b5b09615ae', package_version = '4.0.2'",
    'The HQ storage is invalid: written by jg-agent-hq 4.0.2',
  ],
  [
    // the hash of the schema jg-agent-hq 8.0.2 wrote
    'the 8.0.2 schema',
    "UPDATE hq_schema SET schema_hash = 'bf4d6ad7f2c97adaeb762f7206557999e6ed081d54484d233fe931b31fdf62ab', package_version = '8.0.2'",
    'The HQ storage is invalid: written by jg-agent-hq 8.0.2',
  ],
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
