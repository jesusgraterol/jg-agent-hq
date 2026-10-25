import { z } from 'zod';

import { STORAGE_CONNECTION_SETTINGS } from './constants.js';

// trusted Node-only metadata; application tables have independent schema ownership
export const StorageDescriptorSchema = z.object({
  databasePath: z.string().min(1),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  reservedPrefix: z.literal('hq_'),
  connectionSettings: z.object({
    foreignKeys: z.literal(STORAGE_CONNECTION_SETTINGS.foreignKeys),
    busyTimeoutMs: z.literal(STORAGE_CONNECTION_SETTINGS.busyTimeoutMs),
    journalMode: z.literal(STORAGE_CONNECTION_SETTINGS.journalMode),
    synchronous: z.literal(STORAGE_CONNECTION_SETTINGS.synchronous),
  }),
});
export type IStorageDescriptor = z.infer<typeof StorageDescriptorSchema>;

// host callbacks own their connection and must not call HQ while maintenance is held
export type IStorageMaintenanceOperation<T> = (storage: IStorageDescriptor) => Promise<T>;
