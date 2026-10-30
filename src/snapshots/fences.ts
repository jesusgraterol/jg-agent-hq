import { DatabaseSync } from 'node:sqlite';

import { readStorageStamp } from '../storage/schema/index.js';

import { invalidSnapshot } from './files.js';

/**
 * Releases native ownership and pending native work while retaining immutable receipts and IDs.
 * Source paths remain evidence and require explicit host root selection on startup.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const applyRestoreFences = (filename: string): void => {
  const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  try {
    if (!readStorageStamp(database)) invalidSnapshot();
    database.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      database
        .prepare("UPDATE hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ?")
        .run(now);
      database
        .prepare(
          "UPDATE hq_action SET delivery = 'uncertain', updated_at = ? WHERE delivery = 'submitted'",
        )
        .run(now);
      database.exec('UPDATE hq_action SET queue_ready = 0');
      database
        .prepare(
          "UPDATE hq_native_approval SET state = 'expired', updated_at = ? WHERE state = 'pending'",
        )
        .run(now);
      database.exec('COMMIT');
    } catch (cause) {
      database.exec('ROLLBACK');
      throw cause;
    }
  } finally {
    database.close();
  }
};
