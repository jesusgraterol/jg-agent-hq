import { open, rm } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';

/**
 * Copies the database for a snapshot without the Claude history projection, which a restored
 * runtime rebuilds from the transcripts. A full backup beside the destination loses the
 * projection's rows, then VACUUM INTO writes the compacted copy, keeping every table's rowids.
 * @param database The worker's connection, which keeps serving requests during the backup.
 * @param destination The snapshot's empty database file.
 * @returns Completion once the compacted copy is synced and the full one is removed.
 */
export const backupForSnapshot = async (
  database: DatabaseSync,
  destination: string,
): Promise<void> => {
  const full = `${destination}.full`;
  try {
    await backup(database, full);
    // the full copy is discarded, so it skips journaling, syncing and foreign key checks
    const copy = new DatabaseSync(full, { enableForeignKeyConstraints: false });
    try {
      copy.exec(
        'PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; BEGIN; DELETE FROM hq_claude_entry; DELETE FROM hq_claude_file; COMMIT',
      );
      copy.prepare('VACUUM INTO ?').run(destination);
    } finally {
      copy.close();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(full + suffix, { force: true });
  }
  // VACUUM INTO doesn't sync the file it writes
  const file = await open(destination, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};
