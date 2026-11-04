import type { ISourceState } from './types.js';

/*
 * The time one `threads` page's native reads share, which leaves 10 seconds of the IPC client's
 * 35-second wait for the store reads that complete the page.
 */
export const DISCOVERY_TIMEOUT_SECONDS = 25;

// a source no page has read: any activity time is still possible, and it reads from its start
export const FIRST_READ: ISourceState = [Number.MAX_SAFE_INTEGER, null];
