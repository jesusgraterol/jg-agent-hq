import { DatabaseSync, constants } from 'node:sqlite';
import { Exception, extractMessage } from 'jg-exception';

import type { IStorageDescriptor } from './types.js';

/*
 * The statements that change an object's definition or rows, by the authorizer code SQLite
 * reports. Each names its object first, and an index or trigger its table second, while an
 * update names a column second and an ALTER TABLE its table.
 */
const WRITE_ACTIONS: ReadonlySet<number> = new Set([
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DELETE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
]);

/**
 * Opens a host connection to the database a runtime's storage descriptor names, with the settings
 * the storage contract requires: foreign keys, the busy timeout, full synchronization and the WAL
 * size limit. The connection may read the runtime's tables but not change them or define objects
 * under the reserved prefix: SQLite refuses such a statement with its authorization error. The host
 * owns the connection, and closes it.
 * @param storage The runtime's storage descriptor, from `hq.storage`.
 * @returns The open connection.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const openHostDatabase = (storage: IStorageDescriptor): DatabaseSync => {
  const { databasePath, reservedPrefix, connectionSettings } = storage;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      timeout: connectionSettings.busyTimeoutMs,
      enableForeignKeyConstraints: connectionSettings.foreignKeys,
    });
    database.exec(
      `PRAGMA synchronous = ${connectionSettings.synchronous}; PRAGMA journal_size_limit = ${connectionSettings.journalSizeLimitBytes};`,
    );
    database.setAuthorizer((action, first, second) =>
      WRITE_ACTIONS.has(action) &&
      (first?.startsWith(reservedPrefix) ||
        (action !== constants.SQLITE_UPDATE && second?.startsWith(reservedPrefix)))
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    return database;
  } catch (cause) {
    database?.close();
    throw new Exception(`The HQ store failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORE_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};
