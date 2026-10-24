import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
  unlink,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashValue } from 'jg-crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import {
  createAgentHq,
  inspectHqSnapshot,
  restoreHqSnapshot,
  upgradeHqStorage,
  readHqLockState,
  releaseHqLock,
} from 'jg-agent-hq';
import { expect, test } from 'vitest';

import { withLegacyStorage } from '../../../scripts/test-support/index.js';

const v1Hash = 'af0686f5f4a2af3cbe033a9aab2982d041a4cb0b2fc47088bdd9e15963c66fee';
const open = (stateRoot: string) =>
  new DatabaseSync(join(stateRoot, 'hq.sqlite'), { enableForeignKeyConstraints: true });
const absent = async (path: string) => {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
};

test('published v1 refuses normal startup, then upgrades with a verified legacy backup and preserves host data', async () => {
  await withLegacyStorage(async ({ stateRoot, backupDirectory, workspaceRoot, options }) => {
    const database = open(stateRoot);
    const payload = Buffer.alloc(4 * 1024 * 1024, 7);
    try {
      database.exec(
        'CREATE TABLE app_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT;',
      );
      database.prepare('INSERT INTO app_payload VALUES (1, ?)').run(payload);
    } finally {
      database.close();
    }
    const before = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    const key = await readFile(join(stateRoot, 'action.key'));
    await expectToRejectCode(
      createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
      'JG_AGENT_HQ_STORAGE_UPGRADE_REQUIRED',
      'The HQ storage requires an explicit upgrade',
    );
    expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(before);
    const result = await upgradeHqStorage(options);
    expect(result).toMatchObject({
      state: 'upgraded',
      stateRoot,
      fromVersion: 1,
      toVersion: 2,
      fromSchemaHash: v1Hash,
      backupDirectory,
    });
    expect(result.toSchemaHash).toBe(
      hashValue(await readFile(new URL('../../store/schema.sql', import.meta.url))),
    );
    expect((await inspectHqSnapshot(backupDirectory)).header.schemaHash).toBe(v1Hash);
    expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
    const current = open(stateRoot);
    try {
      const captured = current.prepare('SELECT payload FROM app_payload').get()!.payload;
      expect(captured).toBeInstanceOf(Uint8Array);
      expect((captured as Uint8Array).length).toBe(payload.length);
      expect(hashValue(captured as Uint8Array)).toBe(hashValue(payload));
      expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(37);
      expect(current.prepare('SELECT schema_version FROM hq_schema').get()?.schema_version).toBe(2);
    } finally {
      current.close();
    }
    await absent(join(stateRoot, 'hq-owner.json'));
    await absent(join(stateRoot, 'hq.sock'));
    const runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    await runtime.close();
  });
});

test('current no-op leaves an occupied backup destination and all database state untouched', async () => {
  await withLegacyStorage(async ({ options, root, stateRoot }) => {
    await upgradeHqStorage(options);
    const backupDirectory = join(root, 'occupied');
    await writeFile(backupDirectory, 'Retain this exact file.');
    const before = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    expect(await upgradeHqStorage({ ...options, backupDirectory })).toMatchObject({
      state: 'current',
      fromVersion: 2,
      toVersion: 2,
      backupDirectory: null,
    });
    expect(await readFile(backupDirectory, 'utf8')).toBe('Retain this exact file.');
    expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(before);
  });
});

test.each([
  [
    'unknown baseline',
    "UPDATE hq_schema SET schema_hash = '" + 'a'.repeat(64) + "'",
    'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED',
  ],
  ['missing stamp', 'DROP TABLE hq_schema', 'JG_AGENT_HQ_STORAGE_INVALID'],
  [
    'future version',
    'ALTER TABLE hq_schema ADD COLUMN schema_version INTEGER DEFAULT 99',
    'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED',
  ],
  [
    'conflicting known version',
    'ALTER TABLE hq_schema ADD COLUMN schema_version INTEGER DEFAULT 2',
    'JG_AGENT_HQ_STORAGE_INVALID',
  ],
  [
    'wrong key',
    "UPDATE hq_schema SET action_key_hash = '" + 'b'.repeat(64) + "'",
    'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
  ],
])('%s rejects read-only before reserving a backup', async (_name, sql, code) => {
  await withLegacyStorage(async ({ options, stateRoot, backupDirectory }) => {
    const database = open(stateRoot);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    const before = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    const key = await readFile(join(stateRoot, 'action.key'));
    await expectToRejectCode(upgradeHqStorage(options), code);
    expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(before);
    expect(await readFile(join(stateRoot, 'action.key'))).toStrictEqual(key);
    await absent(backupDirectory);
    await absent(join(stateRoot, 'hq-owner.json'));
  });
});

test.each([
  'missing-key',
  'short-key',
  'symlink-key',
  'hardlink-database',
  'public-database',
  'public-root',
  'symlink-root',
  'missing-root',
])('unsafe source %s is never repaired', async (kind) => {
  await withLegacyStorage(async ({ options, root, stateRoot, backupDirectory }) => {
    let selected = stateRoot;
    if (kind === 'missing-key') {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(stateRoot, 'action.key'));
    }
    if (kind === 'short-key') await writeFile(join(stateRoot, 'action.key'), 'short');
    if (kind === 'symlink-key') {
      const { rename } = await import('node:fs/promises');
      await rename(join(stateRoot, 'action.key'), join(root, 'original-key'));
      await symlink(join(root, 'original-key'), join(stateRoot, 'action.key'));
    }
    if (kind === 'hardlink-database')
      await link(join(stateRoot, 'hq.sqlite'), join(root, 'linked.sqlite'));
    if (kind === 'public-database') await chmod(join(stateRoot, 'hq.sqlite'), 0o644);
    if (kind === 'public-root') await chmod(stateRoot, 0o755);
    if (kind === 'symlink-root') {
      selected = join(root, 'linked');
      await symlink(stateRoot, selected);
    }
    if (kind === 'missing-root') selected = join(root, 'absent');
    const before = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    const code = ['missing-key', 'short-key', 'symlink-key'].includes(kind)
      ? 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE'
      : ['hardlink-database', 'public-database', 'symlink-database'].includes(kind)
        ? 'JG_AGENT_HQ_STATE_FILE_UNSAFE'
        : 'JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE';
    await expectToRejectCode(upgradeHqStorage({ ...options, stateRoot: selected }), code);
    expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(before);
    await absent(backupDirectory);
  });
});

test.each(['live', 'dead', 'incomplete'])(
  'existing %s ownership is never reclaimed',
  async (kind) => {
    await withLegacyStorage(async ({ options, stateRoot, backupDirectory }) => {
      const content =
        kind === 'incomplete'
          ? '{}'
          : JSON.stringify({
              pid: kind === 'live' ? process.pid : 2147483647,
              nonce: crypto.randomUUID(),
              command: 'serve',
              createdAt: new Date().toISOString(),
            });
      await writeFile(join(stateRoot, 'hq-owner.json'), content, { mode: 0o600 });
      await expectToRejectCode(
        upgradeHqStorage(options),
        kind === 'incomplete'
          ? 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE'
          : 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
      );
      expect(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).toBe(content);
      await absent(backupDirectory);
    });
  },
);

test.each([
  'state-child',
  'state-parent',
  'plan-child',
  'plan-parent',
  'existing-output',
  'public-parent',
])('backup %s rejects overlap or unsafe output without migration', async (kind) => {
  await withLegacyStorage(async ({ root, options, stateRoot, workspaceRoot }) => {
    let backupDirectory =
      kind === 'state-child'
        ? join(stateRoot, 'backup')
        : kind === 'state-parent'
          ? root
          : join(root, 'output');
    if (kind.startsWith('plan-')) {
      const directory =
        kind === 'plan-child' ? join(workspaceRoot, 'plan') : join(root, 'output', 'plan');
      const db = open(stateRoot);
      try {
        db.prepare('INSERT INTO hq_plan_registration (directory) VALUES (?)').run(directory);
      } finally {
        db.close();
      }
      backupDirectory = kind === 'plan-child' ? join(directory, 'backup') : join(root, 'output');
      if (kind === 'plan-child') await mkdir(directory);
    }
    if (kind === 'existing-output') await mkdir(backupDirectory);
    if (kind === 'public-parent') {
      await mkdir(join(root, 'public'), { mode: 0o755 });
      backupDirectory = join(root, 'public', 'backup');
    }
    await expectToRejectCode(
      upgradeHqStorage({ ...options, backupDirectory }),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    const db = open(stateRoot);
    try {
      expect(
        db
          .prepare('PRAGMA table_xinfo(hq_schema)')
          .all()
          .some((row) => row.name === 'schema_version'),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});

test('failure after DDL rolls back logically and retains the verified pre-upgrade backup', async () => {
  await withLegacyStorage(async ({ options, stateRoot, backupDirectory }) => {
    const db = open(stateRoot);
    try {
      db.exec(
        "CREATE TRIGGER app_fail_stamp BEFORE UPDATE ON hq_schema BEGIN SELECT RAISE(ABORT, 'Fixture stamp rejection'); END;",
      );
    } finally {
      db.close();
    }
    await expectToRejectCode(
      upgradeHqStorage(options),
      'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED',
      'The HQ storage upgrade failed',
    );
    expect((await inspectHqSnapshot(backupDirectory)).header.schemaHash).toBe(v1Hash);
    const check = open(stateRoot);
    try {
      expect(
        check
          .prepare('PRAGMA table_xinfo(hq_schema)')
          .all()
          .map((row) => row.name),
      ).toStrictEqual(['id', 'schema_hash', 'action_key_hash']);
      expect(check.prepare('SELECT schema_hash FROM hq_schema').get()?.schema_hash).toBe(v1Hash);
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(37);
    } finally {
      check.close();
    }
    await absent(join(stateRoot, 'hq-owner.json'));
  });
});

// the independent held writer exhausts the documented five-second SQLite busy timeout
test('an independent held writer prevents capture and DDL', { timeout: 10000 }, async () => {
  await withLegacyStorage(async ({ options, stateRoot, backupDirectory, workspaceRoot }) => {
    const db = open(stateRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const failedUpgrade = expectToRejectCode(
        upgradeHqStorage(options),
        'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED',
      );
      await expect
        .poll(
          async () => JSON.parse(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).command,
        )
        .toBe('upgrade-storage');
      await expectToRejectCode(upgradeHqStorage(options), 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED');
      await expectToRejectCode(
        createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }),
        'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
      );
      await failedUpgrade;
      await absent(backupDirectory);
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  });
});

// schema comparison owns a bounded package-defined object set, independently initialized on each side
const describeSchema = (database: DatabaseSync) => {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = database
    .prepare('PRAGMA table_list')
    .all()
    .filter((row) => String(row.name).startsWith('hq_'))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return {
    tables: tables.map((table) => ({
      ...table,
      columns: database.prepare(`PRAGMA table_xinfo(${quote(String(table.name))})`).all(),
      foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quote(String(table.name))})`).all(),
      indexes: database
        .prepare(`PRAGMA index_list(${quote(String(table.name))})`)
        .all()
        .map((index) => ({
          ...index,
          columns: database.prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`).all(),
        })),
    })),
    objects: database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name GLOB 'hq_*' OR tbl_name GLOB 'hq_*' ORDER BY type, name",
      )
      .all()
      .map((row) => (row.name === 'hq_schema' ? { ...row, sql: null } : row)),
  };
};

const verifyStampConstraints = (database: DatabaseSync) => {
  database.exec('SAVEPOINT constraints; DELETE FROM hq_schema;');
  try {
    const insert = database.prepare(
      'INSERT INTO hq_schema (id, schema_hash, action_key_hash, schema_version) VALUES (?, ?, ?, ?)',
    );
    for (const version of [0, -1, null, 'invalid'])
      expect(() => insert.run(1, 'a'.repeat(64), 'b'.repeat(64), version)).toThrow();
    expect(() => insert.run(0, 'a'.repeat(64), 'b'.repeat(64), 2)).toThrow();
    expect(() => insert.run(1, 'short', 'b'.repeat(64), 2)).toThrow();
    expect(() => insert.run(1, 'a'.repeat(64), 'short', 2)).toThrow();
    database
      .prepare('INSERT INTO hq_schema (id, schema_hash, action_key_hash) VALUES (1, ?, ?)')
      .run('a'.repeat(64), 'b'.repeat(64));
    expect(database.prepare('SELECT schema_version FROM hq_schema').get()?.schema_version).toBe(2);
    expect(() => insert.run(1, 'a'.repeat(64), 'b'.repeat(64), 2)).toThrow();
    const column = database
      .prepare('PRAGMA table_xinfo(hq_schema)')
      .all()
      .find((entry) => entry.name === 'schema_version');
    expect(column).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '2',
      pk: 0,
      hidden: 0,
    });
  } finally {
    database.exec('ROLLBACK TO constraints; RELEASE constraints;');
  }
};

// independent initialization and an offline backup each own a worker lifecycle
test(
  'upgraded v1 structure, indexes, foreign keys and constraints match independently initialized v2',
  { timeout: 15000 },
  async () => {
    await withLegacyStorage(async ({ options, stateRoot, root, workspaceRoot }) => {
      await upgradeHqStorage(options);
      const freshRoot = join(root, 'fresh');
      const runtime = await createAgentHq({ stateRoot: freshRoot, allowedRoots: [workspaceRoot] });
      await runtime.close();
      const upgraded = open(stateRoot),
        fresh = open(freshRoot);
      try {
        expect(describeSchema(upgraded)).toStrictEqual(describeSchema(fresh));
        verifyStampConstraints(upgraded);
        verifyStampConstraints(fresh);
      } finally {
        upgraded.close();
        fresh.close();
      }
    });
  },
);

// 256 durable companion directories cross the 128-row keyset boundary and require many filesystem syncs
test(
  'offline capture streams multiple plan pages without dropping or duplicating registrations',
  { timeout: 30000 },
  async () => {
    await withLegacyStorage(async ({ options, stateRoot, workspaceRoot, backupDirectory }) => {
      const database = open(stateRoot);
      try {
        const insert = database.prepare('INSERT INTO hq_plan_registration (directory) VALUES (?)');
        for (let index = 0; index < 256; index++) {
          const directory = join(workspaceRoot, `plan-${String(index).padStart(4, '0')}`);
          await mkdir(directory, { mode: 0o700 });
          await writeFile(
            join(directory, 'plan.md'),
            `---\nid: plan-${index}\ncreated_at: 2026-10-23T00:00:00.000Z\nupdated_at: 2026-10-23T00:00:00.000Z\nrevision: 1\nstatus: pending\n---\n# Capture ${index}\n\nRetain this registered plan.\n`,
          );
          insert.run(directory);
        }
      } finally {
        database.close();
      }
      await upgradeHqStorage(options);
      expect(await inspectHqSnapshot(backupDirectory)).toMatchObject({
        planCount: 256,
        diagnosticPlanCount: 0,
      });
    });
  },
);

// fault injection patches only the subprocess runtime boundary; the entire real worker/SQLite flow remains intact
const runFault = async (
  root: string,
  options: Parameters<typeof upgradeHqStorage>[0],
  preloadSource: string,
  expectedCode: string,
) => {
  const preload = join(root, 'fault.mjs'),
    runner = join(root, 'runner.mjs');
  await writeFile(preload, preloadSource);
  await writeFile(
    runner,
    `import assert from 'node:assert/strict';
import { upgradeHqStorage } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
import { hasErrorCode } from ${JSON.stringify(import.meta.resolve('jg-exception'))};
let failure;
try { await upgradeHqStorage(${JSON.stringify(options)}); } catch (error) { failure=error; }
assert.ok(hasErrorCode(failure, ${JSON.stringify(expectedCode)}), failure?.message ?? 'No failure');
`,
  );
  await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
    timeout: 20000,
    maxBuffer: 65536,
  });
};

test.each(['before-commit', 'after-commit', 'lost-response', 'worker-exit'])(
  'worker %s failure preserves recovery and explicit retry reads the durable stamp',
  { timeout: 15000 },
  async (kind) => {
    await withLegacyStorage(async ({ options, root, stateRoot, backupDirectory }) => {
      const preload =
        kind === 'lost-response'
          ? `import { parentPort } from 'node:worker_threads';
if (parentPort) { const original=parentPort.postMessage.bind(parentPort); parentPort.postMessage=(message,...args)=>{ if(message.kind==='result') return; return original(message,...args); }; }
`
          : `import { DatabaseSync } from 'node:sqlite';
const original=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){
  if(sql==='COMMIT' && this.prepare('PRAGMA table_xinfo(hq_schema)').all().some(row=>row.name==='schema_version')) {
    ${kind === 'before-commit' ? "throw new Error('Fixture before commit');" : kind === 'worker-exit' ? 'process.exit(23);' : "original.call(this,sql); throw new Error('Fixture after commit');"}
  }
  return original.call(this,sql);
};
`;
      await runFault(
        root,
        options,
        preload,
        kind === 'before-commit'
          ? 'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED'
          : 'JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN',
      );
      expect((await inspectHqSnapshot(backupDirectory)).header.schemaHash).toBe(v1Hash);
      await absent(join(stateRoot, 'hq-owner.json'));
      const db = open(stateRoot);
      try {
        expect(
          db
            .prepare('PRAGMA table_xinfo(hq_schema)')
            .all()
            .some((row) => row.name === 'schema_version'),
        ).toBe(kind === 'after-commit' || kind === 'lost-response');
      } finally {
        db.close();
      }
      if (kind === 'worker-exit') {
        await expectToRejectCode(
          upgradeHqStorage({ ...options, backupDirectory: join(root, 'retry-backup') }),
          'JG_AGENT_HQ_LOCK_OWNER_INACTIVE',
        );
        const lock = await readHqLockState(stateRoot);
        expect(lock.kind).toBe('held');
        if (lock.kind !== 'held') throw new Error('Missing crash owner');
        expect(lock.liveness).toBe('dead');
        await releaseHqLock(stateRoot, lock.owner.nonce);
      }
      const retried = await upgradeHqStorage({
        ...options,
        backupDirectory: join(root, 'retry-backup'),
      });
      expect(retried.state).toBe(
        kind === 'before-commit' || kind === 'worker-exit' ? 'upgraded' : 'current',
      );
    });
  },
);

test.each(['full-disk', 'corrupt-backup'])(
  'backup %s prevents DDL and removes incomplete output',
  { timeout: 15000 },
  async (kind) => {
    await withLegacyStorage(async ({ options, root, stateRoot, backupDirectory }) => {
      const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original=fs.promises.open;
fs.promises.open=async (...args)=>{
  const handle=await original(...args);
  if(args[0]!==${JSON.stringify(backupDirectory)}+'/manifest.jsonl' || args[1]!=='wx') return handle;
  return new Proxy(handle,{get(target,property){
    if(property==='writeFile') return async (...params)=>{ ${kind === 'full-disk' ? "throw Object.assign(new Error('Fixture full disk'),{code:'ENOSPC'});" : "return target.writeFile('corrupt\\n');"} };
    const member=Reflect.get(target,property,target); return typeof member==='function'?member.bind(target):member;
  }});
};
syncBuiltinESMExports();
`;
      await runFault(
        root,
        options,
        preload,
        kind === 'full-disk'
          ? 'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED'
          : 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await absent(backupDirectory);
      const db = open(stateRoot);
      try {
        expect(
          db
            .prepare('PRAGMA table_xinfo(hq_schema)')
            .all()
            .some((row) => row.name === 'schema_version'),
        ).toBe(false);
      } finally {
        db.close();
      }
      expect((await upgradeHqStorage(options)).state).toBe('upgraded');
    });
  },
);

// restore verifies both source and staged 4 MiB databases before the explicit second backup
test(
  'a legacy restore retains v1 until the operator explicitly upgrades it',
  { timeout: 15000 },
  async () => {
    await withLegacyStorage(async ({ root, options, workspaceRoot, backupDirectory }) => {
      await upgradeHqStorage(options);
      const restored = await restoreHqSnapshot({
        snapshotDirectory: backupDirectory,
        destination: join(root, 'recovery'),
      });
      await expectToRejectCode(
        createAgentHq({ stateRoot: restored.stateRoot, allowedRoots: [workspaceRoot] }),
        'JG_AGENT_HQ_STORAGE_UPGRADE_REQUIRED',
      );
      expect(
        (
          await upgradeHqStorage({
            ...options,
            stateRoot: restored.stateRoot,
            backupDirectory: join(root, 'restored-backup'),
          })
        ).state,
      ).toBe('upgraded');
    });
  },
);

test('unknown v1 state in an uncheckpointed WAL is refused without changing database/key bytes', async () => {
  await withLegacyStorage(async ({ stateRoot, options, backupDirectory }) => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');db.prepare('UPDATE hq_schema SET schema_hash=?').run('d'.repeat(64));process.kill(process.pid,'SIGKILL');`,
          join(stateRoot, 'hq.sqlite'),
        ],
        { timeout: 5000 },
      ),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
    const paths = [
      join(stateRoot, 'hq.sqlite'),
      join(stateRoot, 'hq.sqlite-wal'),
      join(stateRoot, 'action.key'),
    ];
    const before = await Promise.all(paths.map(async (path) => hashValue(await readFile(path))));
    await expectToRejectCode(upgradeHqStorage(options), 'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED');
    expect(
      await Promise.all(paths.map(async (path) => hashValue(await readFile(path)))),
    ).toStrictEqual(before);
    await absent(backupDirectory);
  });
});

test('process death before commit leaves v1 and non-reclaimed ownership with a verified backup', async () => {
  await withLegacyStorage(async ({ options, root, stateRoot, backupDirectory }) => {
    const preload = join(root, 'death.mjs'),
      runner = join(root, 'death-runner.mjs');
    await writeFile(
      preload,
      `import { DatabaseSync } from 'node:sqlite';
const original=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT') process.kill(process.pid,'SIGKILL');return original.call(this,sql);};
`,
    );
    await writeFile(
      runner,
      `import { upgradeHqStorage } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};await upgradeHqStorage(${JSON.stringify(options)});`,
    );
    await expect(
      promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
        timeout: 15000,
      }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
    expect((await inspectHqSnapshot(backupDirectory)).header.schemaHash).toBe(v1Hash);
    const owner = await readFile(join(stateRoot, 'hq-owner.json'), 'utf8');
    await expectToRejectCode(upgradeHqStorage(options), 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED');
    expect(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).toBe(owner);
    const database = open(stateRoot);
    try {
      expect(
        database
          .prepare('PRAGMA table_xinfo(hq_schema)')
          .all()
          .some((row) => row.name === 'schema_version'),
      ).toBe(false);
    } finally {
      database.close();
    }
  });
});

test('an unconfirmed lifetime-owner cleanup reports uncertainty and requires exact-owner reconciliation', async () => {
  await withLegacyStorage(async ({ root, stateRoot, options, backupDirectory }) => {
    await runFault(
      root,
      options,
      `import fs from 'node:fs';import { syncBuiltinESMExports } from 'node:module';
const original=fs.promises.rm;fs.promises.rm=async (...args)=>{if(args[0]===${JSON.stringify(join(stateRoot, 'hq-owner.json'))}) throw new Error('Fixture owner cleanup failure');return original(...args);};syncBuiltinESMExports();
`,
      'JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN',
    );
    expect((await inspectHqSnapshot(backupDirectory)).header.schemaHash).toBe(v1Hash);
    const recorded = await readFile(join(stateRoot, 'hq-owner.json'), 'utf8');
    await expectToRejectCode(upgradeHqStorage(options), 'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED');
    expect(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).toBe(recorded);
    // the child has exited; this fixture explicitly reconciles only its exact unchanged owner
    await unlink(join(stateRoot, 'hq-owner.json'));
    expect((await upgradeHqStorage(options)).state).toBe('current');
  });
});

test('corrupt SQLite storage is refused read-only without replacing source bytes', async () => {
  await withLegacyStorage(async ({ stateRoot, options, backupDirectory }) => {
    await writeFile(join(stateRoot, 'hq.sqlite'), 'Corrupt SQLite header.');
    const before = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    await expectToRejectCode(upgradeHqStorage(options), 'JG_AGENT_HQ_STORAGE_INVALID');
    expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(before);
    await absent(backupDirectory);
  });
});
