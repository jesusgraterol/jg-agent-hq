import type { IResyncLoss } from '../index.js';

// threads read per page of the daemon's loaded threads, and the most pages one connection reads
export const LOADED_THREADS_PAGE_SIZE = 128;
export const MAX_LOADED_THREAD_PAGES = 8;

// turns read per page when timing a history page's items, and the most pages one page reads
export const TURN_TIMES_PAGE_SIZE = 128;
export const MAX_TURN_TIME_PAGES = 8;

// the most threads whose running turn the live events keep
export const RUNNING_TURNS_CAPACITY = 1024;

// the most skill files a catalog read reads at once for their argument hints
export const SKILL_HINT_READ_CONCURRENCY = 8;

// the lifecycle notifications whose loss a live re-check of the session makes up for
export const LOST_NOTIFICATIONS = new Map<string, IResyncLoss>([
  ['turn/started', 'turn-started'],
  ['turn/completed', 'turn-completed'],
  ['serverRequest/resolved', 'approval-resolved'],
]);

// the session statuses this adapter knows; a newer one reads as an unknown native state
export const KNOWN_NATIVE_STATES = ['notLoaded', 'idle', 'systemError', 'active'] as const;

// the service tiers Codex names Fast and standard; a turn's tier also applies to the turns after it
export const CODEX_FAST_SERVICE_TIER = 'priority';
export const CODEX_STANDARD_SERVICE_TIER = 'default';
