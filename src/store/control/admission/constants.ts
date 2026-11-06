import type { IActionReceipt } from '../../../contracts/index.js';

import type { IAdmissionRule } from './types.js';

// a rule's defaults, which each kind's rule overrides with what it needs
const NONE = {
  control: null,
  requiresNoPendingAction: false,
  requiresIdle: false,
  requiresActiveTurn: false,
  takesSlot: false,
  stops: false,
  phase: null,
} as const;

// the one table admission follows for each action kind
export const ADMISSION_RULES: Record<IActionReceipt['kind'], IAdmissionRule> = {
  'thread-create': {
    ...NONE,
    target: 'new',
    takesSlot: true,
    phase: 'create',
    delivery: 'dispatch',
  },
  'thread-adopt': {
    ...NONE,
    target: 'new',
    takesSlot: true,
    phase: 'resume',
    delivery: 'dispatch',
  },
  'thread-resume': {
    ...NONE,
    target: 'thread',
    control: 'resumable',
    takesSlot: true,
    phase: 'resume',
    delivery: 'dispatch',
  },
  'thread-recover': {
    ...NONE,
    target: 'thread',
    control: 'recoverable',
    takesSlot: true,
    phase: 'resume',
    delivery: 'dispatch',
  },
  'thread-rename': {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresNoPendingAction: true,
    phase: 'name',
    delivery: 'dispatch',
  },
  // with `interrupt`, a running turn is interrupted first instead of requiring an idle session
  'thread-close': {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresIdle: true,
    stops: true,
    phase: 'clean',
    delivery: 'dispatch',
  },
  // a session HQ runs is closed first, from clean; one it doesn't is deleted at once
  'thread-delete': {
    ...NONE,
    target: 'session',
    phase: 'delete',
    delivery: 'dispatch',
  },
  message: {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresIdle: true,
    phase: 'turn',
    delivery: 'dispatch',
  },
  'workspace-change': {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresIdle: true,
    phase: 'workspace',
    delivery: 'dispatch',
  },
  queue: {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresActiveTurn: true,
    delivery: 'queue',
  },
  'queue-send': {
    ...NONE,
    target: 'queued',
    control: 'owned',
    requiresIdle: true,
    phase: 'turn',
    delivery: 'dispatch-queued',
  },
  'queue-cancel': { ...NONE, target: 'queued', delivery: 'settle' },
  steer: {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresActiveTurn: true,
    phase: 'steer',
    delivery: 'dispatch',
  },
  interrupt: {
    ...NONE,
    target: 'thread',
    control: 'attached',
    requiresActiveTurn: true,
    stops: true,
    phase: 'interrupt',
    delivery: 'dispatch',
  },
  'native-reply': {
    ...NONE,
    target: 'thread',
    control: 'owned',
    requiresActiveTurn: true,
    phase: 'reply',
    delivery: 'dispatch',
  },
};
