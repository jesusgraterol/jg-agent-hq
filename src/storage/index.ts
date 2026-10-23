// types and validated worker metadata
export { StorageDescriptorSchema, StorageStampSchema } from './types.js';
export type { IStorageDescriptor, IStorageMaintenanceOperation } from './types.js';

// required connection settings
export { STORAGE_CONNECTION_SETTINGS } from './constants.js';

// runtime maintenance admission
export { createStorage } from './storage.js';
