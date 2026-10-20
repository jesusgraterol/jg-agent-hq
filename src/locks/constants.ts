// private runtime metadata under the trusted state root
export const RUNTIME_DIRECTORY = '.runtime';
export const HQ_LOCK_FILE = 'hq.lock';

// a live owner is awaited this long; publishing includes a network push
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

// exclusive creation precedes the owner's first write; an empty lock is tolerated this long
export const DEFAULT_SETUP_WINDOW_MS = 16_000;

// polling interval while a live owner holds the lock
export const DEFAULT_POLL_INTERVAL_MS = 200;

// owner records are labels and identities, never an unbounded transcript
export const MAX_LOCK_OWNER_BYTES = 16_384;
