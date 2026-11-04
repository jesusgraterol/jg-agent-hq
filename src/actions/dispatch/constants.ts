import type { IActionPhase } from '../../contracts/index.js';

/*
 * The phases that continue an action once the one before them is acknowledged: a created
 * session is named, a named one with a first input starts its turn, a cleaned one is closed, and
 * a closed one being deleted is deleted. A close that interrupted a turn continues from clean once
 * the turn ends, which the turn's observation starts.
 */
export const NEXT_PHASES: Partial<Record<IActionPhase, IActionPhase>> = {
  create: 'name',
  name: 'turn',
  clean: 'close',
  close: 'delete',
};
