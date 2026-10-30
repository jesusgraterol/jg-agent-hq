import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHqSnapshot, restoreHqSnapshot, type IAgentHq } from 'jg-agent-hq';

/**
 * Saves one application preference, captures shared storage and verifies an offline restore.
 * Keep other host connections from writing host tables until it returns; agents may keep
 * working. Both output directories must be absent. The caller owns HQ; this helper closes
 * its SQL connections.
 * The application transaction commits before capture and is not rolled back if capture fails.
 * Capture returns verified metadata; restore independently validates the staged copy.
 * @returns The inspected snapshot, its restored state root and the exact restored preference.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 * - Expected the restored host preference
 */
export const shareStorage = async (input: {
  hq: IAgentHq;
  label: string;
  snapshotDirectory: string;
  recoveryDirectory: string;
}) => {
  await input.hq.withStorageMaintenance(async (storage) => {
    const database = new DatabaseSync(storage.databasePath, {
      timeout: storage.connectionSettings.busyTimeoutMs,
      enableForeignKeyConstraints: storage.connectionSettings.foreignKeys,
    });
    try {
      database.exec(
        `PRAGMA synchronous = FULL; PRAGMA journal_size_limit = ${storage.connectionSettings.journalSizeLimitBytes}; BEGIN IMMEDIATE`,
      );
      try {
        database.exec(
          'CREATE TABLE IF NOT EXISTS app_preference (id INTEGER PRIMARY KEY CHECK (id = 1), label TEXT NOT NULL) STRICT',
        );
        database
          .prepare(
            'INSERT INTO app_preference VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label',
          )
          .run(input.label);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      database.close();
    }
  });

  const snapshot = await createHqSnapshot(input.hq, input.snapshotDirectory);
  const restored = await restoreHqSnapshot({
    snapshotDirectory: snapshot.directory,
    destination: input.recoveryDirectory,
  });
  const database = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT label FROM app_preference WHERE id = 1').get();
    if (typeof row?.label !== 'string') throw new Error('Expected the restored host preference');
    return { snapshot, restored, label: row.label };
  } finally {
    database.close();
  }
};
