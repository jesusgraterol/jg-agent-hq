import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { isException } from 'jg-exception';

import { STORAGE_CONNECTION_SETTINGS } from '../storage/index.js';
import {
  PACKAGE_VERSION,
  readStorageStamp,
  upgradeWorkspaceSchema,
} from '../storage/schema/index.js';
import { HQ_ERRORS } from '../errors/index.js';

/**
 * Recognizes an empty schema or validates its singleton stamp without issuing writes.
 * @returns Whether initialization is required.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
const validateSchemaStamp = (database: DatabaseSync, actionKeyHash: string): boolean =>
  readStorageStamp(database, actionKeyHash) === null;

/**
 * Validates through a read-only connection before opening a writer that can checkpoint a WAL.
 * The caller holds exclusive runtime ownership. Fresh initialization and the finite native
 * upgrade each commit atomically before readers; application objects remain untouched.
 * @returns The worker-owned connection and complete HQ schema hash.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const openDatabase = (
  databasePath: string,
  source: string,
  actionKey: Uint8Array,
): { database: DatabaseSync; schemaHash: string } => {
  const schemaHash = hashValue(source);
  const actionKeyHash = hashValue(actionKey);
  const options = {
    timeout: STORAGE_CONNECTION_SETTINGS.busyTimeoutMs,
    enableForeignKeyConstraints: STORAGE_CONNECTION_SETTINGS.foreignKeys,
  };
  let inspection: DatabaseSync | undefined;
  try {
    inspection = new DatabaseSync(databasePath, { ...options, readOnly: true });
    readStorageStamp(inspection, actionKeyHash, true);
  } catch (cause) {
    if (isException(cause)) throw cause;
    throw HQ_ERRORS.create('storageInvalid', { data: { kind: 'state-conflict' }, cause });
  } finally {
    inspection?.close();
  }
  const database = new DatabaseSync(databasePath, options);
  try {
    upgradeWorkspaceSchema(database, source, actionKeyHash);
    if (validateSchemaStamp(database, actionKeyHash)) {
      database.exec('BEGIN IMMEDIATE');
      try {
        if (database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
          throw HQ_ERRORS.create('storageInvalid', { data: { kind: 'state-conflict' } });
        database.exec(source);
        database
          .prepare(
            'INSERT INTO agent_hq_schema (id, schema_hash, action_key_hash, package_version) VALUES (1, ?, ?, ?)',
          )
          .run(schemaHash, actionKeyHash, PACKAGE_VERSION);
        database.exec('COMMIT');
      } catch (cause) {
        database.exec('ROLLBACK');
        throw cause;
      }
    }
    database.exec(
      `PRAGMA journal_mode = ${STORAGE_CONNECTION_SETTINGS.journalMode}; PRAGMA synchronous = ${STORAGE_CONNECTION_SETTINGS.synchronous}; PRAGMA journal_size_limit = ${STORAGE_CONNECTION_SETTINGS.journalSizeLimitBytes};`,
    );
    return { database, schemaHash };
  } catch (error) {
    database.close();
    throw error;
  }
};
