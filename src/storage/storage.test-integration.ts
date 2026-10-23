import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { hashValue } from 'jg-crypto';
import { createAgentHq, type IStorageDescriptor } from 'jg-agent-hq';
import type { IBrowserAction } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime, writeFixtureControl } from '../../scripts/test-support/index.js';

const createGate = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const createHostAction = (runtimeEpoch: string): IBrowserAction => ({
  id: randomUUID(),
  runtimeEpoch,
  command: {
    kind: 'priority',
    target: { directory: '/selected-plan' },
    expectedRevision: { planDigest: 'a'.repeat(64), breakdownDigest: null },
    priority: 'P1',
    reason: 'Host choice',
  },
});

const openStorage = (storage: IStorageDescriptor): DatabaseSync =>
  new DatabaseSync(storage.databasePath, {
    timeout: storage.connectionSettings.busyTimeoutMs,
    enableForeignKeyConstraints: storage.connectionSettings.foreignKeys,
  });

test('shared storage retains application tables and user_version across current-schema reopen', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    const descriptor = runtime.storage;
    expect(descriptor).toMatchObject({
      databasePath: join(stateRoot, 'hq.sqlite'),
      reservedPrefix: 'hq_',
      connectionSettings: {
        foreignKeys: true,
        busyTimeoutMs: 5000,
        journalMode: 'wal',
        synchronous: 'full',
      },
    });
    expect(descriptor.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    await runtime.withStorageMaintenance(async (storage) => {
      const database = openStorage(storage);
      try {
        expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
        expect(database.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
        const objects = database
          .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .all();
        expect(objects.length).toBeGreaterThan(16);
        expect(
          objects.every((row) => typeof row.name === 'string' && row.name.startsWith('hq_')),
        ).toBe(true);
        expect(
          database.prepare('SELECT schema_hash FROM hq_schema WHERE id = 1').get(),
        ).toMatchObject({ schema_hash: descriptor.schemaHash });
        database.exec(
          'CREATE TABLE app_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT; PRAGMA user_version = 37;',
        );
        database
          .prepare('INSERT INTO app_note (id, text) VALUES (?, ?)')
          .run(1, 'Host-owned state');
      } finally {
        database.close();
      }
    });
    descriptor.schemaHash = '0'.repeat(64);
    expect(runtime.storage.schemaHash).not.toBe(descriptor.schemaHash);
    const expected = runtime.storage;
    await runtime.close();
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect(reopened.storage).toStrictEqual(expected);
      const database = openStorage(reopened.storage);
      try {
        expect(
          database
            .prepare('SELECT id, text FROM app_note')
            .all()
            .map((row) => ({ ...row })),
        ).toStrictEqual([{ id: 1, text: 'Host-owned state' }]);
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 37 });
      } finally {
        database.close();
      }
    } finally {
      await reopened.close();
    }
  });
});

test.each(['mismatched', 'missing', 'malformed'])(
  'a %s schema stamp fails startup without changing database or action.key',
  async (kind) => {
    await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
      const storage = runtime.storage;
      await runtime.close();
      const database = openStorage(storage);
      try {
        if (kind === 'mismatched')
          database.prepare('UPDATE hq_schema SET schema_hash = ?').run('0'.repeat(64));
        else {
          database.exec('DROP TABLE hq_schema');
          if (kind === 'malformed') database.exec('CREATE TABLE hq_schema (unrelated TEXT) STRICT');
        }
      } finally {
        database.close();
      }
      const before = await readFile(storage.databasePath);
      const key = await readFile(join(stateRoot, 'action.key'));
      await expectToRejectCode(
        createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
        'JG_AGENT_HQ_STORAGE_INVALID',
        'The HQ storage is invalid',
      );
      expect(await readFile(storage.databasePath)).toStrictEqual(before);
      expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
      await expect(readFile(join(stateRoot, 'hq-owner.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

test('initialization rolls back all HQ objects when its schema execution fails', async () => {
  await withClaudeRuntime(async ({ root, workspaceRoot }) => {
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot);
    await cp(new URL('../../dist/', import.meta.url), join(packageRoot, 'dist'), {
      recursive: true,
    });
    await symlink(
      fileURLToPath(new URL('../../node_modules/', import.meta.url)),
      join(packageRoot, 'node_modules'),
      'dir',
    );
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}\n');
    const schemaPath = join(packageRoot, 'dist', 'store', 'schema.sql');
    await writeFile(
      schemaPath,
      `${await readFile(schemaPath, 'utf8')}\nCREATE TABLE hq_broken (\n`,
    );
    const isolated = (await import(
      pathToFileURL(join(packageRoot, 'dist', 'index.js')).href
    )) as typeof import('jg-agent-hq');
    const stateRoot = join(root, 'failed-state');
    await expectToRejectCode(
      isolated.createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
      'JG_AGENT_HQ_STORE_FAILED',
    );
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(),
      ).toStrictEqual([]);
    } finally {
      database.close();
    }
    await expect(readFile(join(stateRoot, 'hq-owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

test('an invalid stamp in an uncheckpointed WAL is rejected without changing database bytes', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    const path = runtime.storage.databasePath;
    await runtime.close();
    let failure: unknown;
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.argv[1]);
        database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
        database.prepare('UPDATE hq_schema SET schema_hash = ?').run('0'.repeat(64));
        process.stdout.write('written\\n');
        process.kill(process.pid, 'SIGKILL');
      `,
          path,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ signal: 'SIGKILL', stdout: 'written\n' });
    const databaseHash = hashValue(await readFile(path));
    const walHash = hashValue(await readFile(`${path}-wal`));
    await expectToRejectCode(
      createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
      'JG_AGENT_HQ_STORAGE_INVALID',
    );
    expect(hashValue(await readFile(path))).toBe(databaseHash);
    expect(hashValue(await readFile(`${path}-wal`))).toBe(walHash);
  });
});

test('maintenance rejects competing callbacks, HQ requests, host effects and shutdown before running them', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const started = createGate();
    const release = createGate();
    const maintenance = runtime.withStorageMaintenance(async () => {
      started.resolve();
      await release.promise;
      return 'completed';
    });
    try {
      await started.promise;
      const competing = vi.fn(async () => undefined);
      const hostEffect = vi.fn(async () => undefined);
      const action = createHostAction(status.result.runtimeEpoch);
      await expectToRejectCode(
        runtime.withStorageMaintenance(competing),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
      await expectToRejectCode(runtime.request({ kind: 'status' }), 'JG_AGENT_HQ_ACTION_CONFLICT');
      await expectToRejectCode(
        runtime.performBrowserAction(action, 'operator', hostEffect),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
      await expectToRejectCode(runtime.close(), 'JG_AGENT_HQ_ACTION_CONFLICT');
      expect(competing).not.toHaveBeenCalled();
      expect(hostEffect).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await maintenance;
    }
    expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
  });
});

test('maintenance drains admitted host effects including their nested HQ calls before its callback', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const started = createGate();
    const release = createGate();
    const action = createHostAction(status.result.runtimeEpoch);
    const admitted = runtime.performBrowserAction(action, 'operator', async () => {
      started.resolve();
      await release.promise;
      expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
    });
    await started.promise;
    const callback = vi.fn(async (storage: IStorageDescriptor) => {
      const database = openStorage(storage);
      try {
        return database
          .prepare(
            "SELECT json_extract(receipt, '$.state') AS state FROM hq_browser_action WHERE id = ?",
          )
          .get(action.id);
      } finally {
        database.close();
      }
    });
    const maintenance = runtime.withStorageMaintenance(callback);
    try {
      await expectToRejectCode(runtime.request({ kind: 'status' }), 'JG_AGENT_HQ_ACTION_CONFLICT');
      expect(callback).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await admitted;
    }
    expect(await maintenance).toMatchObject({ state: 'acknowledged' });
  });
});

test('callback failures release admission and SQLite contention leaves host state unchanged', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    const first = openStorage(runtime.storage);
    const competing = new DatabaseSync(runtime.storage.databasePath, {
      timeout: 0,
      enableForeignKeyConstraints: true,
    });
    try {
      first.exec('CREATE TABLE app_entry (id INTEGER PRIMARY KEY) STRICT; BEGIN IMMEDIATE');
      await expect(
        runtime.withStorageMaintenance(async () => {
          competing.exec('INSERT INTO app_entry (id) VALUES (1)');
        }),
      ).rejects.toThrow('locked');
      expect(first.prepare('SELECT id FROM app_entry').all()).toStrictEqual([]);
      first.exec('ROLLBACK');
      await runtime.withStorageMaintenance(async () => {
        competing.exec('INSERT INTO app_entry (id) VALUES (1)');
      });
      expect(
        first
          .prepare('SELECT id FROM app_entry')
          .all()
          .map((row) => ({ ...row })),
      ).toStrictEqual([{ id: 1 }]);
      expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
    } finally {
      competing.close();
      first.close();
    }
  });
});

test('an accepted scheduled stop waits until a held maintenance callback releases admission', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    const started = createGate();
    const release = createGate();
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    let maintenance: Promise<void> | undefined;
    try {
      expect(await runtime.request({ kind: 'stop' })).toMatchObject({
        kind: 'stop',
        result: { accepted: true },
      });
      maintenance = runtime.withStorageMaintenance(async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      await vi.runAllTimersAsync();
      await expectToRejectCode(
        runtime.withStorageMaintenance(async () => undefined),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
    } finally {
      vi.useRealTimers();
      release.resolve();
      await maintenance;
      await runtime.closed;
    }
  });
});

test('maintenance drains admitted work that needs newly arriving native lifecycle evidence', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot,
          name: 'storage-drain',
        },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId)
      throw new Error('Missing created thread');
    const threadId = created.result.threadId;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    const pids = z
      .object({ parent: z.number().int().positive() })
      .parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
    const started = createGate();
    const release = createGate();
    const admitted = runtime.performBrowserAction(
      createHostAction(status.result.runtimeEpoch),
      'operator',
      async () => {
        started.resolve();
        await release.promise;
        process.kill(pids.parent, 'SIGTERM');
        await expect
          .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
          .toMatchObject({
            kind: 'managed-thread',
            result: { state: 'unknown', ownership: 'uncertain' },
          });
      },
    );
    await started.promise;
    const callback = vi.fn(async () => undefined);
    const maintenance = expectToRejectCode(
      runtime.withStorageMaintenance(callback),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    const results = Promise.allSettled([admitted, maintenance]);
    release.resolve();
    const [effect, held] = await results;
    expect(effect.status).toBe('fulfilled');
    if (effect.status === 'fulfilled')
      expect(effect.value).toMatchObject({ state: 'acknowledged' });
    expect(held.status).toBe('fulfilled');
    expect(callback).not.toHaveBeenCalled();
  });
});

test('an admitted host effect cannot acquire maintenance and wait on its own completion', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const callback = vi.fn(async () => undefined);
    const receipt = await runtime.performBrowserAction(
      createHostAction(status.result.runtimeEpoch),
      'operator',
      async () => {
        await expectToRejectCode(
          runtime.withStorageMaintenance(callback),
          'JG_AGENT_HQ_ACTION_CONFLICT',
        );
      },
    );
    expect(receipt.state).toBe('acknowledged');
    expect(callback).not.toHaveBeenCalled();
    await runtime.withStorageMaintenance(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

test('maintenance refuses active native execution without invoking the host callback', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    await writeFixtureControl(root, 'control.json', { holdTurn: true });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const create = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot,
          name: 'storage-review',
        },
      },
    });
    if (create.kind !== 'action' || !create.result.threadId)
      throw new Error('Missing created thread');
    const threadId = create.result.threadId;
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
          input: { kind: 'text', text: 'Inspect the workspace' },
        },
      },
    });
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'running' } });
    const callback = vi.fn(async () => undefined);
    await expectToRejectCode(
      runtime.withStorageMaintenance(callback),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    expect(callback).not.toHaveBeenCalled();
  });
});

test('native transport failure during maintenance is retained and persisted after release', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Unexpected status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot,
          name: 'storage-events',
        },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId)
      throw new Error('Missing created thread');
    const threadId = created.result.threadId;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({
        kind: 'managed-thread',
        result: { state: 'idle' },
      });
    const pids = z
      .object({ parent: z.number().int().positive() })
      .parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
    await runtime.withStorageMaintenance(async (storage) => {
      process.kill(pids.parent, 'SIGTERM');
      await expect
        .poll(() => {
          try {
            process.kill(pids.parent, 0);
            return true;
          } catch (error) {
            if (hasErrorCode(error, 'ESRCH')) return false;
            throw error;
          }
        })
        .toBe(false);
      const database = openStorage(storage);
      try {
        expect(
          database.prepare('SELECT state FROM hq_thread WHERE id = ?').get(threadId),
        ).toMatchObject({ state: 'idle' });
      } finally {
        database.close();
      }
    });
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({
        kind: 'managed-thread',
        result: { state: 'unknown', ownership: 'uncertain' },
      });
  });
});
