import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { Exception, isException } from 'jg-exception';

import { STORAGE_CONNECTION_SETTINGS } from '../storage/index.js';
import { PACKAGE_VERSION, readStorageStamp } from '../storage/schema/index.js';

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
 * Fresh schema and stamp creation share one transaction; application objects are not converted.
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
    validateSchemaStamp(inspection, actionKeyHash);
  } catch (cause) {
    if (isException(cause)) throw cause;
    throw new Exception('The HQ storage is invalid', {
      code: 'JG_AGENT_HQ_STORAGE_INVALID',
      data: { kind: 'state-conflict' },
      cause,
    });
  } finally {
    inspection?.close();
  }
  const database = new DatabaseSync(databasePath, options);
  try {
    if (validateSchemaStamp(database, actionKeyHash)) {
      database.exec('BEGIN IMMEDIATE');
      try {
        if (database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
          throw new Exception('The HQ storage is invalid', {
            code: 'JG_AGENT_HQ_STORAGE_INVALID',
            data: { kind: 'state-conflict' },
          });
        database.exec(source);
        database
          .prepare(
            'INSERT INTO hq_schema (id, schema_hash, action_key_hash, package_version) VALUES (1, ?, ?, ?)',
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
