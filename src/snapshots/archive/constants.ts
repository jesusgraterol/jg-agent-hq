// leading bytes that identify the archive layout below
export const ARCHIVE_FORMAT = Buffer.from('JGHQSNA1', 'latin1');

// AES-256-GCM parameters: a 32-byte operator key, a fresh 12-byte IV and a 16-byte tag
export const ARCHIVE_KEY_BYTES = 32;
export const ARCHIVE_IV_BYTES = 12;
export const ARCHIVE_TAG_BYTES = 16;

// each entry is a 2-byte path length, the UTF-8 path and an 8-byte content length
export const ARCHIVE_PATH_BYTES = 4096;
