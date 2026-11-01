import type { IResyncLoss } from '../../providers/index.js';

// how long a re-check waits before reading again a turn whose saved state may trail its notification
export const RESYNC_REREAD_DELAY_SECONDS = 2;

// lost kinds in rising order of what their re-check must prove; merged requests keep the highest
export const RESYNC_LOSS_ORDER: readonly IResyncLoss[] = [
  'unknown',
  'turn-started',
  'turn-completed',
  'approval-resolved',
];
