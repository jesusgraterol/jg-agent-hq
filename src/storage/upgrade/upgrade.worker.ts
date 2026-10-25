import { readFile } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

import { getErrorKind } from '../../errors/index.js';
import { acquireHqLock } from '../../locks/index.js';
import { isWithinWorkspace, readExistingState } from '../../runtime/state/index.js';
import { captureSnapshot, verifySnapshot } from '../../snapshots/index.js';
import {
  CURRENT_SCHEMA_VERSION,
  STORAGE_MIGRATIONS,
  STORAGE_SCHEMAS,
  readStorageSchema,
} from '../schema/index.js';
import { STORAGE_CONNECTION_SETTINGS } from '../constants.js';

import {
  UpgradeWorkerInputSchema,
  UpgradeResultSchema,
  type IHqStorageUpgradeResult,
} from './types.js';

const port = parentPort;
if (!port)
  throw new Exception('The HQ storage upgrade failed', {
    code: 'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED',
  });
let phase = 'preflight';
let verifiedBackup: string | null = null;
let database: DatabaseSync | undefined;
let release: (() => Promise<void>) | undefined;
let hasCommitted = false;
let result: IHqStorageUpgradeResult | undefined;
let failure: unknown;

try {
  const input = UpgradeWorkerInputSchema.parse(workerData);
  const state = await readExistingState(input.stateRoot);
  if (hashValue(state.actionKey) !== input.actionKeyHash)
    throw new Exception('The HQ action key is unavailable', {
      code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
      data: { kind: 'state-conflict' },
    });
  database = new DatabaseSync(state.databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: STORAGE_CONNECTION_SETTINGS.busyTimeoutMs,
  });
  const observed = readStorageSchema(database, input.actionKeyHash);
  if (!observed)
    throw new Exception('The HQ storage is invalid', {
      code: 'JG_AGENT_HQ_STORAGE_INVALID',
      data: { kind: 'state-conflict' },
    });
  const target = STORAGE_SCHEMAS.find((entry) => entry.version === CURRENT_SCHEMA_VERSION)!;
  const base = {
    stateRoot: state.stateRoot,
    fromVersion: observed.schema.version,
    toVersion: target.version,
    fromSchemaHash: observed.schema.hash,
    toSchemaHash: target.hash,
  };
  if (observed.schema.version === target.version) {
    result = { ...base, state: 'current', backupDirectory: null };
  } else {
    // validate every selected source before reserving output; pages remain bounded for growing registries
    let after = '';
    for (;;) {
      const page = database
        .prepare(
          'SELECT directory FROM hq_plan_registration WHERE directory > ? ORDER BY directory LIMIT 128',
        )
        .all(after);
      for (const row of page) {
        const directory = z.string().parse(row.directory);
        if (
          isWithinWorkspace(input.backupDirectory, directory) ||
          isWithinWorkspace(directory, input.backupDirectory)
        )
          throw new Exception('The HQ snapshot is invalid', {
            code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
            data: { kind: 'invalid-request' },
          });
        after = directory;
      }
      if (page.length < 128) break;
    }
    database.close();
    database = undefined;
    phase = 'metadata-lock';
    release = await acquireHqLock(input.coordinationRoot ?? state.stateRoot, 'upgrade-storage', {
      waitTimeoutMs: 0,
    });
    const checkpoint = await readExistingState(state.stateRoot);
    if (hashValue(checkpoint.actionKey) !== input.actionKeyHash)
      throw new Exception('The HQ action key is unavailable', {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
      });
    database = new DatabaseSync(state.databasePath, {
      enableForeignKeyConstraints: true,
      timeout: STORAGE_CONNECTION_SETTINGS.busyTimeoutMs,
    });
    database.exec(
      `PRAGMA journal_mode = ${STORAGE_CONNECTION_SETTINGS.journalMode}; PRAGMA synchronous = ${STORAGE_CONNECTION_SETTINGS.synchronous}; BEGIN IMMEDIATE`,
    );
    const locked = readStorageSchema(database, input.actionKeyHash);
    if (
      locked?.schema.version !== observed.schema.version ||
      locked.schema.hash !== observed.schema.hash
    )
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
      });
    phase = 'backup';
    const writer = database;
    await captureSnapshot(
      {
        stateRoot: state.stateRoot,
        coordinationRoot: input.coordinationRoot ?? state.stateRoot,
        allowedRoots: input.allowedRoots,
        actionKeyHash: input.actionKeyHash,
        schemaHash: observed.schema.hash,
        readPlans: async (cursor) =>
          writer
            .prepare(
              'SELECT directory FROM hq_plan_registration WHERE directory > ? ORDER BY directory LIMIT 128',
            )
            .all(cursor)
            .map((row) => z.string().parse(row.directory)),
        backupDatabase: async (destination) => {
          // an active writer cannot be the source of sqlite3_backup; readers see the locked committed state
          const source = new DatabaseSync(state.databasePath, {
            readOnly: true,
            enableForeignKeyConstraints: true,
          });
          try {
            await backup(source, destination);
          } finally {
            source.close();
          }
          const copy = new DatabaseSync(destination);
          try {
            copy.exec('PRAGMA journal_mode = DELETE');
          } finally {
            copy.close();
          }
        },
        verify: verifySnapshot,
      },
      input.backupDirectory,
    );
    verifiedBackup = input.backupDirectory;
    phase = 'migration';
    const edge = STORAGE_MIGRATIONS.find(
      (entry) =>
        entry.fromVersion === observed.schema.version && entry.toVersion === target.version,
    );
    if (!edge)
      throw new Exception('The HQ storage version is unsupported', {
        code: 'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED',
        data: { kind: 'state-conflict' },
      });
    database.exec(await readFile(edge.source, 'utf8'));
    database
      .prepare('UPDATE hq_schema SET schema_version = ?, schema_hash = ? WHERE id = 1')
      .run(target.version, target.hash);
    const migrated = readStorageSchema(database, input.actionKeyHash);
    if (migrated?.schema.version !== target.version || migrated.schema.hash !== target.hash)
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
      });
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== 'ok' ||
      database.prepare('PRAGMA foreign_key_check').get()
    )
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
      });
    phase = 'commit';
    database.exec('COMMIT');
    hasCommitted = true;
    result = { ...base, state: 'upgraded', backupDirectory: verifiedBackup };
  }
} catch (cause) {
  failure = cause;
  // a post-COMMIT exception can precede the assignment above; autocommit distinguishes that uncertainty
  if (phase === 'commit' && database && !database.isTransaction) hasCommitted = true;
  if (database?.isTransaction) {
    try {
      database.exec('ROLLBACK');
    } catch (cleanup) {
      hasCommitted = true;
      failure = new AggregateError([cause, cleanup], 'Upgrade rollback could not be confirmed');
    }
  }
} finally {
  try {
    database?.close();
    await release?.();
  } catch (cause) {
    hasCommitted = true;
    failure = failure ? new AggregateError([failure, cause], 'Upgrade cleanup failed') : cause;
    phase = 'cleanup';
  }
}

try {
  if (failure) {
    const error = hasCommitted
      ? new Exception(
          `The HQ storage upgrade requires reconciliation: ${extractMessage(failure)}`,
          {
            code: 'JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN',
            data: { kind: 'operation-failed' },
            cause: failure,
          },
        )
      : isException(failure) && failure.code.startsWith('JG_AGENT_HQ_')
        ? failure
        : new Exception(`The HQ storage upgrade failed: ${extractMessage(failure)}`, {
            code: 'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED',
            data: { kind: 'operation-failed' },
            cause: failure,
          });
    port.postMessage({
      kind: 'error',
      code: error.code,
      message: extractMessage(error),
      cause: failure instanceof Error ? failure : undefined,
      data: { kind: getErrorKind(error), phase, backupDirectory: verifiedBackup },
    });
  } else port.postMessage({ kind: 'result', result: UpgradeResultSchema.parse(result) });
} finally {
  port.close();
}
