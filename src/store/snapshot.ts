import { open, rm } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';

/** Owns the snapshot copy of the worker's database. */
export class SnapshotModel {
  private readonly __database: DatabaseSync;

  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(database: DatabaseSync) {
    this.__database = database;
  }

  /**
   * Copies the database for a snapshot without the Claude history projection, which a restored
   * runtime rebuilds from the transcripts. A full backup beside the destination loses the
   * projection's rows, then VACUUM INTO writes the compacted copy, keeping every table's rowids.
   * The worker's connection keeps serving requests during the backup.
   * @param destination The snapshot's empty database file.
   * @returns Completion once the compacted copy is synced and the full one is removed.
   */
  public async backup(destination: string): Promise<void> {
    const full = `${destination}.full`;
    try {
      await backup(this.__database, full);
      // the full copy is discarded, so it skips journaling, syncing and foreign key checks
      const copy = new DatabaseSync(full, { enableForeignKeyConstraints: false });
      try {
        copy.exec(
          'PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; BEGIN; DELETE FROM agent_hq_claude_entry; DELETE FROM agent_hq_claude_file; COMMIT',
        );
        copy.prepare('VACUUM INTO ?').run(destination);
      } finally {
        copy.close();
      }
    } finally {
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        await rm(full + suffix, { force: true });
    }
    // VACUUM INTO doesn't sync the file it writes
    const file = await open(destination, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
