import type { IActionPhase } from '../../../contracts/index.js';

// what one action kind needs from its thread, and how admission hands it to native dispatch
export type IAdmissionRule = {
  // a new thread, the thread the command names, or the thread of the queued action it names
  target: 'new' | 'thread' | 'queued';
  /*
   * The control the thread must be under: owned by this runtime, attached to this runtime however
   * its ownership stands, closed and resumable, or uncertain and recoverable by this runtime. A
   * resumable or recoverable thread has no action in flight in this runtime.
   */
  control: 'owned' | 'attached' | 'resumable' | 'recoverable' | null;
  // no action of the thread's is in flight, though a turn may run
  requiresNoPendingAction: boolean;
  // no turn runs, no action is in flight and the last turn, if any, has ended
  requiresIdle: boolean;
  // the turn the command names is the thread's active one
  requiresActiveTurn: boolean;
  // the thread joins this runtime's bounded set of controlled sessions
  takesSlot: boolean;
  // the thread stops: its state becomes stopping and its queued input waits
  stops: boolean;
  // the native step the dispatched action takes; a create recovery takes create instead
  phase: IActionPhase | null;
  /*
   * Dispatches the action itself, holds it as the thread's queued input, settles it at once
   * without native work, or dispatches the queued action it names.
   */
  delivery: 'dispatch' | 'queue' | 'settle' | 'dispatch-queued';
};
