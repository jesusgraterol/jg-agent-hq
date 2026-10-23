// settings required on each host-owned SQLite connection
export const STORAGE_CONNECTION_SETTINGS = {
  foreignKeys: true,
  busyTimeoutMs: 5000,
  journalMode: 'wal',
  synchronous: 'full',
} as const;
