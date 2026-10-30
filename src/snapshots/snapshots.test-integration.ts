import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq, createHqSnapshot, inspectHqSnapshot, restoreHqSnapshot } from 'jg-agent-hq';
import { hashValue } from 'jg-crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  withClaudeRuntime,
  writeFixtureControl,
} from '../../scripts/test-support/index.js';

const faults = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== 'wx' || !faults.target || !String(args[0]).includes(faults.target))
        return handle;
      faults.target = '';
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'write' || property === 'writeFile')
            return async () => {
              throw Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' });
            };
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    },
  };
});
afterEach(() => {
  faults.target = '';
});

const readManifest = async (directory: string) =>
  (await readFile(join(directory, 'manifest.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));

test('WAL-aware capture includes host tables and key but no plan files; offline restore requires new roots and starts without providers', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot, stateRoot }) => {
    // plan files in a workspace are never captured
    await mkdir(join(workspaceRoot, 'selected-plan'));
    await writeFile(join(workspaceRoot, 'selected-plan', 'plan.md'), '# Selected plan\n');
    const host = new DatabaseSync(runtime.storage.databasePath);
    try {
      host.exec(
        'PRAGMA wal_autocheckpoint = 0; CREATE TABLE app_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT; PRAGMA user_version = 37',
      );
      host.prepare('INSERT INTO app_note VALUES (?, ?)').run(1, 'Committed in WAL');
      expect((await lstat(runtime.storage.databasePath + '-wal')).size).toBeGreaterThan(0);
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      expect(snapshot).toMatchObject({
        header: { sourceStateRoot: stateRoot, sourceAllowedRoots: [workspaceRoot] },
      });
      expect(await inspectHqSnapshot(snapshot.directory)).toStrictEqual(snapshot);
      expect((await readdir(snapshot.directory)).sort()).toStrictEqual([
        'action.key',
        'complete.json',
        'hq.sqlite',
        'manifest.jsonl',
      ]);
      expect((await readManifest(snapshot.directory)).map((entry) => entry.kind)).toStrictEqual([
        'header',
        'database',
        'action-key',
      ]);
      expect(await readFile(join(snapshot.directory, 'action.key'))).toStrictEqual(
        await readFile(join(stateRoot, 'action.key')),
      );
      for (const name of ['hq-owner.json', 'control.sock', 'hq.lock'])
        await expect(lstat(join(snapshot.directory, name))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(root, 'recovery'),
      });
      expect((await readdir(join(root, 'recovery'))).sort()).toStrictEqual([
        'recovered.json',
        'recovery.jsonl',
        'state',
      ]);
      expect((await lstat(restored.stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(restored.stateRoot, 'action.key'))).mode & 0o777).toBe(0o600);
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [workspaceRoot],
      });
      try {
        const status = await reopened.request({ kind: 'status' });
        expect(status).toMatchObject({
          kind: 'status',
          result: {
            providers: [
              { provider: 'codex', state: 'idle' },
              { provider: 'claude', state: 'idle' },
            ],
          },
        });
        const db = new DatabaseSync(reopened.storage.databasePath);
        try {
          expect(db.prepare('SELECT body FROM app_note').get()?.body).toBe('Committed in WAL');
          expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(37);
        } finally {
          db.close();
        }
      } finally {
        await reopened.close();
      }
    } finally {
      host.close();
    }
  });
});

test('a snapshot leaves out the Claude history index and keeps host rowids; a restored runtime rebuilds the index from the transcripts', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const question = claudeRecord(workspaceRoot, nativeId, { text: 'Kept in the transcript' });
    await writeFile(transcript(nativeId), `${JSON.stringify(question)}\n`);
    expect(await request({ kind: 'threads', provider: 'claude', workspaceRoot })).toMatchObject({
      kind: 'threads',
      result: { data: [{ nativeId }] },
    });
    // a host table without an integer key, whose rowids a plain VACUUM would renumber
    const host = new DatabaseSync(runtime.storage.databasePath);
    try {
      host.exec('CREATE TABLE app_event (body TEXT NOT NULL) STRICT');
      for (const body of ['first', 'second', 'third'])
        host.prepare('INSERT INTO app_event (body) VALUES (?)').run(body);
      host.prepare('DELETE FROM app_event WHERE body = ?').run('second');
    } finally {
      host.close();
    }
    const readState = (databasePath: string) => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return {
          ...database
            .prepare(
              'SELECT (SELECT count(*) FROM hq_claude_file) AS files, (SELECT count(*) FROM hq_claude_entry) AS entries',
            )
            .get(),
          events: database
            .prepare('SELECT rowid, body FROM app_event ORDER BY rowid')
            .all()
            .map((row) => ({ ...row })),
        };
      } finally {
        database.close();
      }
    };
    const events = [
      { rowid: 1, body: 'first' },
      { rowid: 3, body: 'third' },
    ];
    expect(readState(runtime.storage.databasePath)).toStrictEqual({ files: 1, entries: 1, events });
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(readState(join(snapshot.directory, 'hq.sqlite'))).toStrictEqual({
      files: 0,
      entries: 0,
      events,
    });
    expect((await readdir(snapshot.directory)).sort()).toStrictEqual([
      'action.key',
      'complete.json',
      'hq.sqlite',
      'manifest.jsonl',
    ]);
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    const reopened = await createAgentHq({
      stateRoot: restored.stateRoot,
      allowedRoots: [workspaceRoot],
    });
    try {
      expect(
        await reopened.request({ kind: 'threads', provider: 'claude', workspaceRoot }),
      ).toMatchObject({ kind: 'threads', result: { data: [{ nativeId }] } });
      const items = await reopened.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
      });
      expect(items.kind === 'items' && items.result.data.map((item) => item.text)).toStrictEqual([
        'Kept in the transcript',
      ]);
    } finally {
      await reopened.close();
    }
    expect(readState(join(restored.stateRoot, 'hq.sqlite'))).toStrictEqual({
      files: 1,
      entries: 1,
      events,
    });
  });
});

test('capture uses construction roots rather than a mutated public runtime object', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
    const other = join(root, 'other-state');
    await mkdir(other, { mode: 0o700 });
    await writeFile(join(other, 'action.key'), Buffer.alloc(32), { mode: 0o600 });
    const expectedKeyHash = hashValue(await readFile(join(stateRoot, 'action.key')));
    runtime.stateRoot = other;
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(snapshot.header.sourceStateRoot).toBe(stateRoot);
    expect(hashValue(await readFile(join(snapshot.directory, 'action.key')))).toBe(expectedKeyHash);
  });
});

test('capture rejects an action key changed after startup and never publishes a mismatched pair', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
    const filename = join(stateRoot, 'action.key'),
      original = await readFile(filename);
    try {
      await writeFile(filename, Buffer.alloc(32), { mode: 0o600 });
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await writeFile(filename, original, { mode: 0o600 });
    }
    expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).header.sourceStateRoot).toBe(
      stateRoot,
    );
  });
});

test('startup rejects a different valid-length action key before changing the database', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot, workspaceRoot }) => {
    await runtime.close();
    const filename = join(stateRoot, 'action.key'),
      original = await readFile(filename);
    const databaseHash = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    let unexpected: Awaited<ReturnType<typeof createAgentHq>> | undefined;
    try {
      await writeFile(filename, Buffer.alloc(32), { mode: 0o600 });
      const opening = (async () => {
        unexpected = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
        return unexpected;
      })();
      await expectToRejectCode(opening, 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE');
      expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(databaseHash);
      await expect(lstat(join(stateRoot, 'hq-owner.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await unexpected?.close();
      await writeFile(filename, original, { mode: 0o600 });
    }
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect(
        (await createHqSnapshot(reopened, join(root, 'snapshot'))).header.sourceStateRoot,
      ).toBe(stateRoot);
    } finally {
      await reopened.close();
    }
  });
});

test('host maintenance excludes capture, while capture proceeds through a native turn that completes meanwhile', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const maintenance = runtime.withStorageMaintenance(async () => {
      started();
      await held;
    });
    await admitted;
    try {
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
    } finally {
      release();
      await maintenance;
    }
    await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFixtureControl(root, 'control.json', { holdTurn: true, interruptDelay: 50 });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'snapshot-busy' },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
    const threadId = created.result.threadId;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId,
          input: { kind: 'text', text: 'Hold the native turn.' },
        },
      },
    });
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'running' } });
    const running = await runtime.request({ kind: 'managed-thread', threadId });
    if (running.kind !== 'managed-thread' || !running.result?.activeTurnId)
      throw new Error('Missing turn');
    // the turn is interrupted and completes while the capture is underway
    const capture = createHqSnapshot(runtime, join(root, 'snapshot'));
    await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'interrupt', threadId, expectedTurnId: running.result.activeTurnId },
      },
    });
    const snapshot = await capture;
    expect(await inspectHqSnapshot(snapshot.directory)).toStrictEqual(snapshot);
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'interrupted' } });
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    const database = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      expect({
        ...database.prepare('SELECT ownership, state FROM hq_thread WHERE id = ?').get(threadId),
      }).toStrictEqual({ ownership: 'uncertain', state: 'unknown' });
    } finally {
      database.close();
    }
  });
});

test('capture takes the HQ lock in the state root and leaves a dead holder for explicit recovery', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'close');
    if (!child.pid) throw new Error('test process did not start');
    const lock = join(stateRoot, '.runtime', 'hq.lock');
    const owner = JSON.stringify({
      pid: child.pid,
      nonce: randomUUID(),
      command: 'holder',
      createdAt: new Date().toISOString(),
    });
    await mkdir(join(stateRoot, '.runtime'), { recursive: true, mode: 0o700 });
    await writeFile(lock, owner, { mode: 0o600 });
    await expectToRejectCode(
      createHqSnapshot(runtime, join(root, 'snapshot')),
      'JG_AGENT_HQ_SNAPSHOT_FAILED',
      'The HQ lock has an inactive owner',
    );
    await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(lock, 'utf8')).toBe(owner);
    await rm(lock);
    expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).header.sourceStateRoot).toBe(
      stateRoot,
    );
  });
});

test.each(['action.key', 'hq.sqlite', 'manifest.jsonl', 'complete.json'])(
  'missing or corrupt %s prevents restore without creating a target',
  async (name) => {
    await withClaudeRuntime(async ({ runtime, root }) => {
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      const filename = join(snapshot.directory, name);
      if (name === 'hq.sqlite' || name === 'manifest.jsonl')
        await writeFile(filename, 'corrupt', { mode: 0o600 });
      else await rm(filename);
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expectToRejectCode(
        restoreHqSnapshot({
          snapshotDirectory: snapshot.directory,
          destination: join(root, 'recovery'),
        }),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);

test.each([
  'file-link',
  'shared-key',
  'omitted-record',
  'extra-record',
  'bad-schema',
  'wrong-key-pair',
])(
  'inspection rejects %s even when the attacker recomputes manifest completion',
  async (attack) => {
    await withClaudeRuntime(async ({ runtime, root }) => {
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      const entries = await readManifest(snapshot.directory);
      if (attack === 'file-link') {
        await rm(join(snapshot.directory, 'action.key'));
        await symlink(
          join(runtime.stateRoot, 'action.key'),
          join(snapshot.directory, 'action.key'),
        );
      }
      if (attack === 'shared-key') await chmod(join(snapshot.directory, 'action.key'), 0o644);
      if (attack === 'omitted-record') entries.pop();
      if (attack === 'extra-record') entries.push(entries[2]!);
      if (attack === 'bad-schema') entries[0].schemaHash = '0'.repeat(64);
      if (attack === 'wrong-key-pair') {
        const key = Buffer.alloc(32);
        await writeFile(join(snapshot.directory, 'action.key'), key, { mode: 0o600 });
        entries[2].file = { bytes: 32, sha256: hashValue(key) };
      }
      const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      await writeFile(join(snapshot.directory, 'manifest.jsonl'), text, { mode: 0o600 });
      await writeFile(
        join(snapshot.directory, 'complete.json'),
        JSON.stringify({ manifestSha256: hashValue(text), records: entries.length }),
        { mode: 0o600 },
      );
      // a header from another schema names the package version that claims to have written it
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        attack === 'bad-schema' ? 'JG_AGENT_HQ_STORAGE_INVALID' : 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
    });
  },
);

test('occupied snapshot and restore targets, including a live state root, remain untouched', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    const before = await readFile(join(snapshot.directory, 'complete.json'));
    await expectToRejectCode(
      createHqSnapshot(runtime, snapshot.directory),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(await readFile(join(snapshot.directory, 'complete.json'))).toStrictEqual(before);
    const key = await readFile(join(runtime.stateRoot, 'action.key'));
    for (const destination of [runtime.stateRoot, workspaceRoot, snapshot.directory])
      await expectToRejectCode(
        restoreHqSnapshot({ snapshotDirectory: snapshot.directory, destination }),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
    expect(await readFile(join(runtime.stateRoot, 'action.key'))).toStrictEqual(key);
    expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
  });
});

test.each(['/snapshot/manifest.jsonl', '/snapshot/action.key'])(
  'full-disk failure at %s removes owned output and releases admission',
  async (target) => {
    await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
      faults.target = target;
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_SNAPSHOT_FAILED',
        'Injected full disk',
      );
      await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).header.sourceStateRoot).toBe(
        stateRoot,
      );
    });
  },
);

test('a restore copy failure removes its private workspace, preserves source evidence and can be retried', async () => {
  await withClaudeRuntime(async ({ runtime, root }) => {
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    const before = await readFile(join(snapshot.directory, 'complete.json'));
    const preload = join(root, 'restore-fault.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await original(...args);
  if (args[1] !== 'wx' || !String(args[0]).includes('/recovery/staging/')) return handle;
  return new Proxy(handle, { get(target, property) {
    if (property === 'write' || property === 'writeFile') return async () => { throw Object.assign(new Error('Injected restore ENOSPC'), { code: 'ENOSPC' }); };
    const member = Reflect.get(target, property, target);
    return typeof member === 'function' ? member.bind(target) : member;
  }});
};
syncBuiltinESMExports();\n`,
    );
    const runner = join(root, 'restore-runner.mjs');
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
import { restoreHqSnapshot } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
import { hasErrorCode, extractMessage } from ${JSON.stringify(import.meta.resolve('jg-exception'))};
try {
  await restoreHqSnapshot(${JSON.stringify({ snapshotDirectory: snapshot.directory, destination: join(root, 'recovery') })});
  assert.fail('Restore unexpectedly succeeded');
} catch (error) {
  assert.ok(hasErrorCode(error, 'JG_AGENT_HQ_SNAPSHOT_FAILED'));
  assert.equal(extractMessage(error), 'The HQ snapshot operation failed: Injected restore ENOSPC');
}\n`,
    );
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(snapshot.directory, 'complete.json'))).toStrictEqual(before);
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    expect(await readFile(join(restored.stateRoot, 'action.key'))).toStrictEqual(
      await readFile(join(runtime.stateRoot, 'action.key')),
    );
  });
});

test('restore rejects a source replaced by another valid snapshot after initial inspection', async () => {
  await withClaudeRuntime(async ({ runtime, root }) => {
    const first = await createHqSnapshot(runtime, join(root, 'first'));
    await runtime.withStorageMaintenance(async (storage) => {
      const host = new DatabaseSync(storage.databasePath);
      try {
        host.exec('CREATE TABLE app_marker (id INTEGER PRIMARY KEY) STRICT');
      } finally {
        host.close();
      }
    });
    const second = await createHqSnapshot(runtime, join(root, 'second'));
    expect(second.manifestSha256).not.toBe(first.manifestSha256);
    const destination = join(root, 'recovery');
    const preload = join(root, 'replace-source.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.mkdir;
fs.promises.mkdir = async (...args) => {
  const result = await original(...args);
  if (args[0] === ${JSON.stringify(destination)})
    for (const name of ['hq.sqlite', 'action.key', 'manifest.jsonl', 'complete.json'])
      await fs.promises.copyFile(${JSON.stringify(second.directory)} + '/' + name, ${JSON.stringify(first.directory)} + '/' + name);
  return result;
};
syncBuiltinESMExports();\n`,
    );
    const runner = join(root, 'replace-runner.mjs');
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
import { restoreHqSnapshot } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
import { hasErrorCode } from ${JSON.stringify(import.meta.resolve('jg-exception'))};
let failure;
try { await restoreHqSnapshot(${JSON.stringify({ snapshotDirectory: first.directory, destination })}); }
catch (error) { failure = error; }
assert.ok(hasErrorCode(failure, 'JG_AGENT_HQ_SNAPSHOT_INVALID'), 'Replaced source was accepted');\n`,
    );
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await inspectHqSnapshot(first.directory)).manifestSha256).toBe(second.manifestSha256);
  });
});

// a complete capture/restore and fresh-runtime worker lifecycle around a stopped-controller checkpoint
test(
  'submitted receipts, queued input and live approvals are fenced without replay',
  { timeout: 15000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const status = await fixture.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await fixture.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot: fixture.workspaceRoot,
            name: 'fenced-session',
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      const threadId = created.result.threadId;
      await expect
        .poll(() => fixture.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
      const actionId = randomUUID(),
        approvalId = randomUUID(),
        queueId = randomUUID();
      const queuedInput = JSON.stringify({
        text: 'Exact queued input',
        skill: null,
        files: [],
        settings: {},
      });
      // seed a stopped-controller crash checkpoint; capture proceeds while work is submitted
      await fixture.runtime.withStorageMaintenance(async (storage) => {
        const db = new DatabaseSync(storage.databasePath);
        try {
          const now = Date.now();
          db.prepare(
            'INSERT INTO hq_action (id,digest,requested_runtime_epoch,runtime_epoch,kind,thread_id,delivery,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)',
          ).run(
            actionId,
            'a'.repeat(64),
            status.result.runtimeEpoch,
            status.result.runtimeEpoch,
            'message',
            threadId,
            'submitted',
            now,
            now,
          );
          db.prepare(
            "INSERT INTO hq_action (id,digest,requested_runtime_epoch,runtime_epoch,kind,thread_id,delivery,queued_input,queue_ready,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,1,?,?)",
          ).run(
            queueId,
            'b'.repeat(64),
            status.result.runtimeEpoch,
            status.result.runtimeEpoch,
            'queue',
            threadId,
            queuedInput,
            now,
            now,
          );
          db.prepare(
            "INSERT INTO hq_native_approval (id,thread_id,native_turn_id,runtime_epoch,native_request_id,digest,kind,is_blocking,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'command',1,'pending',?,?)",
          ).run(
            approvalId,
            threadId,
            'stopped-turn',
            status.result.runtimeEpoch,
            'native-permission',
            'c'.repeat(64),
            now,
            now,
          );
        } finally {
          db.close();
        }
      });
      const snapshot = await createHqSnapshot(fixture.runtime, join(fixture.root, 'snapshot'));
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(fixture.root, 'recovery'),
      });
      const db = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'));
      try {
        expect(
          db
            .prepare('SELECT delivery, native_request_id FROM hq_action WHERE id = ?')
            .get(actionId),
        ).toMatchObject({ delivery: 'uncertain', native_request_id: null });
        expect(
          db
            .prepare('SELECT delivery, queued_input, queue_ready FROM hq_action WHERE id = ?')
            .get(queueId),
        ).toMatchObject({
          delivery: 'queued',
          queued_input: queuedInput,
          queue_ready: 0,
        });
        expect(
          db.prepare('SELECT state FROM hq_native_approval WHERE id = ?').get(approvalId)?.state,
        ).toBe('expired');
      } finally {
        db.close();
      }
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
      });
      try {
        const current = await reopened.request({ kind: 'status' });
        if (current.kind !== 'status') throw new Error('Missing status');
        expect(current.result.runtimeEpoch).not.toBe(status.result.runtimeEpoch);
        expect(current.result.providers.every((provider) => provider.state === 'idle')).toBe(true);
        expect(await reopened.request({ kind: 'receipt', actionId })).toMatchObject({
          kind: 'receipt',
          result: { delivery: 'uncertain' },
        });
      } finally {
        await reopened.close();
      }
    });
  },
);

// only fixture-owned complete inventories are rewritten; production capture/verification remains real
const refreshDatabaseInventory = async (
  directory: string,
  header?: { schemaHash: string; packageVersion: string },
) => {
  const entries = await readManifest(directory);
  const database = await readFile(join(directory, 'hq.sqlite'));
  entries[1].file = { bytes: database.length, sha256: hashValue(database) };
  if (header) Object.assign(entries[0], header);
  const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await writeFile(join(directory, 'manifest.jsonl'), text);
  await writeFile(
    join(directory, 'complete.json'),
    JSON.stringify({ manifestSha256: hashValue(text), records: entries.length }),
  );
};

test.each(['header', 'database'])(
  'a snapshot whose %s comes from another schema is refused by name before restore reserves its destination',
  async (source) => {
    await withClaudeRuntime(async ({ runtime, root }) => {
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      if (source === 'database') {
        const database = new DatabaseSync(join(snapshot.directory, 'hq.sqlite'));
        try {
          database
            .prepare('UPDATE hq_schema SET schema_hash = ?, package_version = ?')
            .run('f'.repeat(64), '9.9.9');
        } finally {
          database.close();
        }
        await refreshDatabaseInventory(snapshot.directory);
      } else
        await refreshDatabaseInventory(snapshot.directory, {
          schemaHash: 'f'.repeat(64),
          packageVersion: '9.9.9',
        });
      const before = hashValue(await readFile(join(snapshot.directory, 'hq.sqlite')));
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        'JG_AGENT_HQ_STORAGE_INVALID',
        'The HQ storage is invalid: written by jg-agent-hq 9.9.9',
      );
      await expectToRejectCode(
        restoreHqSnapshot({
          snapshotDirectory: snapshot.directory,
          destination: join(root, 'recovery'),
        }),
        'JG_AGENT_HQ_STORAGE_INVALID',
        'written by jg-agent-hq 9.9.9',
      );
      await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(hashValue(await readFile(join(snapshot.directory, 'hq.sqlite')))).toBe(before);
    });
  },
);

// the header and records jg-agent-hq 8.0.2 wrote, with a field and records this schema lacks
test("a snapshot with another schema's header fields and records is refused by name before its shape is checked", async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot, workspaceRoot }) => {
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    const entries = await readManifest(snapshot.directory);
    Object.assign(entries[0]!, {
      schemaHash: 'bf4d6ad7f2c97adaeb762f7206557999e6ed081d54484d233fe931b31fdf62ab',
      packageVersion: '8.0.2',
      sourceCoordinationRoot: stateRoot,
    });
    const directory = join(workspaceRoot, 'selected-plan');
    entries.push({
      kind: 'plan',
      key: hashValue(directory),
      sourceDirectory: directory,
      planId: null,
      revision: null,
      recordedRevisions: [],
      plan: null,
      milestones: null,
      coordination: null,
      diagnostics: ['plan-missing'],
    });
    const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(join(snapshot.directory, 'manifest.jsonl'), text);
    await writeFile(
      join(snapshot.directory, 'complete.json'),
      JSON.stringify({ manifestSha256: hashValue(text), records: entries.length }),
    );
    await expectToRejectCode(
      inspectHqSnapshot(snapshot.directory),
      'JG_AGENT_HQ_STORAGE_INVALID',
      'The HQ storage is invalid: written by jg-agent-hq 8.0.2',
    );
    await expectToRejectCode(
      restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(root, 'recovery'),
      }),
      'JG_AGENT_HQ_STORAGE_INVALID',
      'written by jg-agent-hq 8.0.2',
    );
    await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
