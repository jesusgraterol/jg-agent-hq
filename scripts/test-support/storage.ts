import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { onTestFinished } from 'vitest';

const V1_HASH = 'af0686f5f4a2af3cbe033a9aab2982d041a4cb0b2fc47088bdd9e15963c66fee';

/** Recreates only the stamp of a stopped v2 fixture; all business tables are identical in v1. */
export const useLegacyStamp = async (stateRoot: string): Promise<void> => {
  const source = await readFile(
    new URL('../../src/storage/schema/v1.sql', import.meta.url),
    'utf8',
  );
  const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
  try {
    const stamp = database.prepare('SELECT action_key_hash FROM hq_schema').get();
    database.exec('BEGIN IMMEDIATE; DROP TABLE hq_schema;');
    database.exec(source.slice(0, source.indexOf('CREATE TABLE hq_native_history_index')));
    database
      .prepare('INSERT INTO hq_schema (id, schema_hash, action_key_hash) VALUES (1, ?, ?)')
      .run(V1_HASH, stamp!.action_key_hash!);
    database.exec('COMMIT');
  } finally {
    database.close();
  }
};

/** Owns an immutable-2.0.0 database and its complete disposable filesystem boundary. */
export const withLegacyStorage = async (
  operation: (fixture: {
    root: string;
    stateRoot: string;
    workspaceRoot: string;
    backupDirectory: string;
    options: { stateRoot: string; backupDirectory: string; allowedRoots: string[] };
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-upgrade-'));
  let operationPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => (cleanupPromise ??= rm(root, { recursive: true, force: true }));
  onTestFinished(async () => {
    await operationPromise?.catch(() => undefined);
    await cleanup();
  });
  try {
    const stateRoot = join(root, 'state'),
      workspaceRoot = join(root, 'workspace'),
      backupDirectory = join(root, 'backup');
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const key = randomBytes(32);
    await writeFile(join(stateRoot, 'action.key'), key, { mode: 0o600 });
    const source = await readFile(
      new URL('../../src/storage/schema/v1.sql', import.meta.url),
      'utf8',
    );
    if (hashValue(source) !== V1_HASH) throw new Error('Immutable v1 SQL changed');
    const path = join(stateRoot, 'hq.sqlite');
    const database = new DatabaseSync(path);
    try {
      database.exec(source);
      database
        .prepare('INSERT INTO hq_schema (id, schema_hash, action_key_hash) VALUES (1, ?, ?)')
        .run(V1_HASH, hashValue(key));
      database.exec('PRAGMA user_version = 37; PRAGMA journal_mode = WAL;');
    } finally {
      database.close();
    }
    await chmod(path, 0o600);
    operationPromise = operation({
      root,
      stateRoot,
      workspaceRoot,
      backupDirectory,
      options: { stateRoot, backupDirectory, allowedRoots: [workspaceRoot] },
    });
    await operationPromise;
  } finally {
    await cleanup();
  }
};
