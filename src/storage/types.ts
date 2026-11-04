// trusted Node-only metadata; application tables have independent schema ownership
export type IStorageDescriptor = {
  databasePath: string;
  schemaHash: string;
  reservedPrefix: 'agent_hq_';
  connectionSettings: {
    foreignKeys: true;
    busyTimeoutMs: 5000;
    journalMode: 'wal';
    synchronous: 'full';
    journalSizeLimitBytes: 16_777_216;
  };
};

// host callbacks own their connection and must not call HQ while maintenance is held
export type IStorageMaintenanceOperation<T> = (storage: IStorageDescriptor) => Promise<T>;
