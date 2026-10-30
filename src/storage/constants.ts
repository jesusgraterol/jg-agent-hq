/*
 * Settings required on each host-owned SQLite connection. The journal size limit shrinks the WAL
 * file back to 16 MiB after a checkpoint, on the connection whose write starts the WAL over.
 */
export const STORAGE_CONNECTION_SETTINGS = {
  foreignKeys: true,
  busyTimeoutMs: 5000,
  journalMode: 'wal',
  synchronous: 'full',
  journalSizeLimitBytes: 16_777_216,
} as const;
