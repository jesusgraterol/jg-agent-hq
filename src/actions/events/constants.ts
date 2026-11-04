import type { INativeObservation } from '../../store/control/index.js';

// item observations never change a receipt, and are too frequent to wake waits for
export const ITEM_OBSERVATIONS: ReadonlySet<INativeObservation['kind']> = new Set([
  'item-started',
  'item-completed',
]);

// the most history pages of 128 items a finished turn's own read takes, as a Codex page reads turns
export const TURN_FLUSH_PAGES = 8;
