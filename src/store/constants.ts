/*
 * The worker runs about 140 distinct statements, counting each variant of its paged and filtered
 * reads, so the next power of two holds all of them and none is prepared again after its first
 * run. A statement past the capacity only evicts the least recently used one, to prepare again.
 */
export const STATEMENT_CACHE_CAPACITY = 256;
