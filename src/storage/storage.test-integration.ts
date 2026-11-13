import { cp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { hashValue } from 'jg-crypto';
import { inspectLock } from 'jg-locks';
import {
  createAgentHq,
  openHostDatabase,
  restoreHqSnapshot,
  type IAgentHqOptions,
  type IStorageDescriptor,
} from 'jg-agent-hq';
import type { IBrowserAction } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  claudeRecord,
  stateLocks,
  withClaudeRuntime,
  writeFixtureControl,
  waitForWarmUp,
} from '../../scripts/test-support/index.js';

const createGate = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

// a native effect for the host's dispatcher, which these tests never submit to HQ
const createHostAction = (runtimeEpoch: string): IBrowserAction => ({
  id: randomUUID(),
  runtimeEpoch,
  command: {
    kind: 'native',
    action: {
      id: randomUUID(),
      runtimeEpoch,
      command: {
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot: '/selected-workspace',
        name: 'host-request',
      },
    },
  },
});

const openStorage = (storage: IStorageDescriptor): DatabaseSync =>
  new DatabaseSync(storage.databasePath, {
    timeout: storage.connectionSettings.busyTimeoutMs,
    enableForeignKeyConstraints: storage.connectionSettings.foreignKeys,
  });

test('startup host initialization rejects a non-function before taking ownership', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    await runtime.close();
    await expectToRejectCode(
      createAgentHq({
        stateRoot,
        allowedRoots: [workspaceRoot],
        initializeHostStorage: false,
      } as unknown as IAgentHqOptions),
      'JG_AGENT_HQ_REQUEST_INVALID',
    );
    expect((await inspectLock('runtime', stateLocks(stateRoot))).state).toBe('free');
  });
});

test('startup host initialization holds ownership before provider calls or IPC admission', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot, root }) => {
    await waitForWarmUp(runtime);
    await runtime.close();
    const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
    const claudeCalls = await readFile(join(root, 'claude-calls.jsonl'), 'utf8');
    const key = await readFile(join(stateRoot, 'action.key'));
    const entered = createGate();
    const release = createGate();
    const initializeHostStorage = vi.fn(async (storage: IStorageDescriptor) => {
      const database = openHostDatabase(storage);
      try {
        database.exec('CREATE TABLE app_startup (id INTEGER PRIMARY KEY) STRICT');
        expect(() => database.exec('DELETE FROM agent_hq_schema')).toThrow('not authorized');
        entered.resolve();
        await release.promise;
      } finally {
        database.close();
      }
    });
    const starting = createAgentHq({
      stateRoot,
      allowedRoots: [workspaceRoot],
      initializeHostStorage,
    });
    // observe rejection immediately, including when exercising the pre-fix options schema
    const outcome = starting.then(
      (started) => ({ started }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect.poll(() => initializeHostStorage.mock.calls.length).toBe(1);
      await entered.promise;
      expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe(calls);
      expect(await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).toBe(claudeCalls);
      await expect(stat(join(stateRoot, 'hq.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expectToRejectCode(
        createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
        'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
      );
    } finally {
      release.resolve();
      const result = await outcome;
      if ('started' in result) await result.started.close();
    }
    await expect(starting).resolves.toMatchObject({ storage: runtime.storage });
    expect(initializeHostStorage).toHaveBeenCalledTimes(1);
    expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
  });
});

test('failed startup host initialization rolls back and releases ownership without starting providers', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot, root }) => {
    await waitForWarmUp(runtime);
    await runtime.close();
    const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
    const claudeCalls = await readFile(join(root, 'claude-calls.jsonl'), 'utf8');
    const key = await readFile(join(stateRoot, 'action.key'));
    const failure = new Error('Host migration rejected');
    await expect(
      createAgentHq({
        stateRoot,
        allowedRoots: [workspaceRoot],
        initializeHostStorage: async (storage) => {
          const database = openHostDatabase(storage);
          try {
            database.exec(
              'BEGIN IMMEDIATE; CREATE TABLE app_partial (id INTEGER); PRAGMA user_version = 99',
            );
            throw failure;
          } finally {
            database.exec('ROLLBACK');
            database.close();
          }
        },
      }),
    ).rejects.toBe(failure);
    expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe(calls);
    expect(await readFile(join(root, 'claude-calls.jsonl'), 'utf8')).toBe(claudeCalls);
    expect((await inspectLock('runtime', stateLocks(stateRoot))).state).toBe('free');
    const retry = await createAgentHq({
      stateRoot,
      allowedRoots: [workspaceRoot],
      initializeHostStorage: async (storage) => {
        const database = openHostDatabase(storage);
        try {
          expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 });
          expect(
            database.prepare("SELECT name FROM sqlite_schema WHERE name = 'app_partial'").get(),
          ).toBeUndefined();
          expect(database.prepare('SELECT schema_hash FROM agent_hq_schema').get()).toMatchObject({
            schema_hash: runtime.storage.schemaHash,
          });
        } finally {
          database.close();
        }
      },
    });
    try {
      expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
    } finally {
      await retry.close();
    }
  });
});

test('startup host initialization migrates before a retained Codex turn rejoins without replay', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot, root }) => {
    await writeFixtureControl(root, 'control.json', { holdTurn: true });
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: runtime.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot,
          name: 'startup-storage',
        },
      },
    });
    const threadId = created.result.threadId!;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ result: { state: 'idle' } });
    const actionId = randomUUID();
    await runtime.request({
      kind: 'action',
      action: {
        id: actionId,
        runtimeEpoch: runtime.runtimeEpoch,
        command: {
          kind: 'message',
          threadId,
          input: { kind: 'text', text: 'Keep this exact running turn' },
        },
      },
    });
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ result: { state: 'running' } });
    const active = (await runtime.request({ kind: 'managed-thread', threadId })).result!;
    const receipt = (await runtime.request({ kind: 'receipt', actionId })).result!;
    const key = await readFile(join(stateRoot, 'action.key'));
    await runtime.close();
    await writeFixtureControl(root, 'control.json', {
      holdTurn: true,
      threadStatuses: { [active.nativeId!]: { type: 'active' } },
      threadTurns: {
        [active.nativeId!]: [{ id: active.activeTurnId, status: 'inProgress', items: [] }],
      },
    });
    const initializeHostStorage = vi.fn(async (storage: IStorageDescriptor) => {
      const database = openHostDatabase(storage);
      try {
        expect(
          database
            .prepare('SELECT active_turn_id, runtime_epoch FROM agent_hq_thread WHERE id = ?')
            .get(threadId),
        ).toMatchObject({
          active_turn_id: active.activeTurnId,
          runtime_epoch: runtime.runtimeEpoch,
        });
        database.exec(
          'BEGIN IMMEDIATE; CREATE TABLE app_restart (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT',
        );
        database.prepare('INSERT INTO app_restart VALUES (?, ?)').run(1, 'Retained through rejoin');
        database.exec('PRAGMA user_version = 38; COMMIT');
      } finally {
        database.close();
      }
    });
    const restarted = await createAgentHq({
      stateRoot,
      allowedRoots: [workspaceRoot],
      initializeHostStorage,
    });
    try {
      await expect
        .poll(() => restarted.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({
          result: {
            ownership: 'managed',
            runtimeEpoch: restarted.runtimeEpoch,
            state: 'running',
            nativeId: active.nativeId,
            activeTurnId: active.activeTurnId,
          },
        });
      expect(initializeHostStorage).toHaveBeenCalledTimes(1);
      expect((await restarted.request({ kind: 'receipt', actionId })).result).toStrictEqual(
        receipt,
      );
      expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
      expect(restarted.storage.schemaHash).toBe(runtime.storage.schemaHash);
      const database = openHostDatabase(restarted.storage);
      try {
        expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 38 });
        expect(database.prepare('SELECT body FROM app_restart').get()).toMatchObject({
          body: 'Retained through rejoin',
        });
      } finally {
        database.close();
      }
      const maintenance = vi.fn(async () => undefined);
      await expectToRejectCode(
        restarted.withStorageMaintenance(maintenance),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
      expect(maintenance).not.toHaveBeenCalled();
      const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string });
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
      expect(calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  });
});

test('12.0.1 storage opens unchanged and longer names survive restart and snapshot restore', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot, root }) => {
    const descriptor = runtime.storage;
    const key = await readFile(join(stateRoot, 'action.key'));
    await runtime.close();
    const database = openStorage(descriptor);
    try {
      // a previous writer's diagnostic version with the same schema and original action key
      database.prepare('UPDATE agent_hq_schema SET package_version = ?').run('12.0.1');
      database.exec(
        'CREATE TABLE app_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT; PRAGMA user_version = 37',
      );
      database.prepare('INSERT INTO app_note VALUES (?, ?)').run(1, 'Keep the host record');
    } finally {
      database.close();
    }
    const upgraded = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    let threadId: string;
    let nativeId: string | null;
    try {
      expect(upgraded.storage).toStrictEqual(descriptor);
      const runtimeEpoch = (await upgraded.request({ kind: 'status' })).result.runtimeEpoch;
      const admitted = await upgraded.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot,
            name: 'build-agent-composer-with-inline-code-blocks-and-markdown-tables',
          },
        },
      });
      const settled = await upgraded.request({
        kind: 'action-wait',
        actionId: admitted.result.id,
        until: 'settled',
        timeoutMs: 5000,
      });
      expect(settled.result).toMatchObject({
        isTimedOut: false,
        receipt: { delivery: 'acknowledged' },
      });
      threadId = admitted.result.threadId!;
      nativeId = (await upgraded.request({ kind: 'managed-thread', threadId })).result!.nativeId;
    } finally {
      await upgraded.close();
    }
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect(reopened.storage).toStrictEqual(descriptor);
      const expected = {
        id: threadId,
        nativeId,
        name: 'build-agent-composer-with-inline-code-blocks-and-markdown-tables',
      };
      expect((await reopened.request({ kind: 'managed-thread', threadId })).result).toMatchObject(
        expected,
      );
      expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
      const host = openStorage(reopened.storage);
      try {
        expect(host.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 37 });
        expect(host.prepare('SELECT body FROM app_note WHERE id = 1').get()).toMatchObject({
          body: 'Keep the host record',
        });
        expect(host.prepare('SELECT schema_hash FROM agent_hq_schema').get()).toMatchObject({
          schema_hash: descriptor.schemaHash,
        });
      } finally {
        host.close();
      }
      const snapshot = await reopened.createSnapshot(join(root, 'long-name-snapshot'));
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(root, 'long-name-recovery'),
      });
      expect(await readFile(join(restored.stateRoot, 'action.key'))).toStrictEqual(key);
      const recovered = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [workspaceRoot],
      });
      try {
        expect(recovered.storage.schemaHash).toBe(descriptor.schemaHash);
        expect(
          (await recovered.request({ kind: 'managed-thread', threadId })).result,
        ).toMatchObject(expected);
      } finally {
        await recovered.close();
      }
    } finally {
      await reopened.close();
    }
  });
});

test('shared storage retains application tables and user_version across current-schema reopen', async () => {
  await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
    const descriptor = runtime.storage;
    expect(descriptor).toMatchObject({
      databasePath: join(stateRoot, 'hq.sqlite'),
      reservedPrefix: 'agent_hq_',
      connectionSettings: {
        foreignKeys: true,
        busyTimeoutMs: 5000,
        journalMode: 'wal',
        synchronous: 'full',
        journalSizeLimitBytes: 16_777_216,
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
          objects.every((row) => typeof row.name === 'string' && row.name.startsWith('agent_hq_')),
        ).toBe(true);
        expect(
          database.prepare('SELECT schema_hash FROM agent_hq_schema WHERE id = 1').get(),
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

test('openHostDatabase applies the connection settings and keeps host statements out of the reserved prefix', async () => {
  await withClaudeRuntime(async ({ runtime }) => {
    await runtime.withStorageMaintenance(async (storage) => {
      const database = openHostDatabase(storage);
      try {
        const read = (pragma: string) => ({ ...database.prepare(`PRAGMA ${pragma}`).get() });
        expect(read('foreign_keys')).toStrictEqual({ foreign_keys: 1 });
        expect(read('busy_timeout')).toStrictEqual({ timeout: 5000 });
        // FULL is 2
        expect(read('synchronous')).toStrictEqual({ synchronous: 2 });
        expect(read('journal_size_limit')).toStrictEqual({ journal_size_limit: 16_777_216 });
        expect(read('journal_mode')).toStrictEqual({ journal_mode: 'wal' });
        database.exec(
          'CREATE TABLE app_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT; CREATE INDEX app_idx_note__text ON app_note (text); PRAGMA user_version = 3;',
        );
        database.prepare('INSERT INTO app_note (id, text) VALUES (?, ?)').run(1, 'Host-owned');
        database.prepare('UPDATE app_note SET text = ? WHERE id = ?').run('Host-owned note', 1);
        expect({ ...database.prepare('SELECT text FROM app_note').get() }).toStrictEqual({
          text: 'Host-owned note',
        });
        // HQ's tables stay readable
        expect({
          ...database.prepare('SELECT count(*) AS count FROM agent_hq_thread').get(),
        }).toStrictEqual({
          count: 0,
        });
        for (const statement of [
          'CREATE TABLE agent_hq_note (id INTEGER PRIMARY KEY) STRICT',
          'CREATE INDEX app_idx_thread__name ON agent_hq_thread (name)',
          'CREATE TRIGGER app_trg_thread AFTER DELETE ON agent_hq_thread BEGIN SELECT 1; END',
          'CREATE VIEW agent_hq_view AS SELECT 1',
          "UPDATE agent_hq_schema SET package_version = 'host'",
          'DELETE FROM agent_hq_event',
          "INSERT INTO agent_hq_observed_session (provider, native_id, state, observed_at) VALUES ('codex', 'x', 'idle', 0)",
          'ALTER TABLE agent_hq_thread ADD COLUMN app_note TEXT',
          'DROP INDEX agent_hq_idx_a__native_turn_id',
          'DROP TABLE agent_hq_event',
        ])
          expect(() => database.exec(statement), statement).toThrow('not authorized');
        expect({ ...database.prepare('PRAGMA user_version').get() }).toStrictEqual({
          user_version: 3,
        });
      } finally {
        database.close();
      }
    });
  });
});

test("HQ's connection shrinks a WAL file a host grew back to the 16 MiB journal size limit", async () => {
  await withClaudeRuntime(async ({ runtime, workspaceRoot, transcript, request }) => {
    const limit = runtime.storage.connectionSettings.journalSizeLimitBytes;
    const walSize = async () => (await stat(`${runtime.storage.databasePath}-wal`)).size;
    // a host connection without the limit or automatic checkpoints grows the WAL past it
    const host = openStorage(runtime.storage);
    try {
      host.exec(
        'PRAGMA wal_autocheckpoint = 0; CREATE TABLE app_blob (id INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT',
      );
      const insert = host.prepare('INSERT INTO app_blob (body) VALUES (?)');
      for (let index = 0; index < 20; index += 1) insert.run(Buffer.alloc(1_048_576, index));
    } finally {
      host.close();
    }
    expect(await walSize()).toBeGreaterThan(limit);
    /*
     * Indexing two new transcripts commits several HQ writes: the first one checkpoints the WAL,
     * and a later one starts it over and truncates it to the limit.
     */
    for (const nativeId of [randomUUID(), randomUUID()])
      await writeFile(
        transcript(nativeId),
        `${JSON.stringify(claudeRecord(workspaceRoot, nativeId))}\n`,
      );
    expect(
      await request({ kind: 'threads', providers: ['claude'], workspaceRoots: [workspaceRoot] }),
    ).toMatchObject({
      kind: 'threads',
      result: { data: [{}, {}] },
    });
    expect(await walSize()).toBeLessThanOrEqual(limit);
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
          database.prepare('UPDATE agent_hq_schema SET schema_hash = ?').run('0'.repeat(64));
        else {
          database.exec('DROP TABLE agent_hq_schema');
          if (kind === 'malformed')
            database.exec('CREATE TABLE agent_hq_schema (unrelated TEXT) STRICT');
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
      expect((await inspectLock('runtime', stateLocks(stateRoot))).state).toBe('free');
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
    await writeFile(
      join(packageRoot, 'package.json'),
      '{"type":"module","version":"0.0.0-isolated"}\n',
    );
    const schemaPath = join(packageRoot, 'dist', 'store', 'schema.sql');
    await writeFile(
      schemaPath,
      `${await readFile(schemaPath, 'utf8')}\nCREATE TABLE agent_hq_broken (\n`,
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
    expect((await inspectLock('runtime', stateLocks(stateRoot))).state).toBe('free');
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
        database.prepare('UPDATE agent_hq_schema SET schema_hash = ?').run('0'.repeat(64));
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
          .prepare('SELECT state FROM agent_hq_browser_action WHERE id = ?')
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
        const thread = (await runtime.request({ kind: 'managed-thread', threadId })).result!;
        // an unavailable native identity remains unresolved after automatic transport recovery
        await writeFixtureControl(root, 'control.json', {
          threadStatuses: { [thread.nativeId!]: { type: 'systemError' } },
        });
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
          database.prepare('SELECT state FROM agent_hq_thread WHERE id = ?').get(threadId),
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
