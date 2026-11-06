// identity
export { CURRENT_SCHEMA_HASH, PACKAGE_VERSION, KNOWN_PREVIOUS_SCHEMA_HASH } from './constants.js';

// finite startup upgrade
export { upgradeWorkspaceSchema } from './upgrade.js';

// recognition
export { readStorageStamp, rejectStorage } from './schema.js';
