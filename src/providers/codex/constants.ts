// threads read per page of the daemon's loaded threads, and the most pages one connection reads
export const LOADED_THREADS_PAGE_SIZE = 128;
export const MAX_LOADED_THREAD_PAGES = 8;

// turns read per page when timing a history page's items, and the most pages one page reads
export const TURN_TIMES_PAGE_SIZE = 128;
export const MAX_TURN_TIME_PAGES = 8;

// the most threads whose running turn the live events keep
export const RUNNING_TURNS_CAPACITY = 1024;
