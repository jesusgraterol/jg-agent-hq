// the private jg-locks folder under the state root, and the locks HQ takes there
export const LOCKS_DIRECTORY = ['.runtime', 'locks'] as const;
export const RUNTIME_LOCK = 'runtime';
export const SNAPSHOT_LOCK = 'snapshot';

export const DATABASE_FILE = 'hq.sqlite';
export const ACTION_KEY_FILE = 'action.key';
