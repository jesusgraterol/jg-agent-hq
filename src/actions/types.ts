import type { IManagedThread, ISessionTerminal } from '../contracts/index.js';
import type { INativePrompt } from '../providers/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import type { createSkills } from '../skills/index.js';
import type { IStore } from '../store/index.js';

import type { LiveItems } from './live/index.js';
import type { ActionWaits, ChangeWaits } from './waits/index.js';

/*
 * The change a long-poll waits for: a new session transition, or a change of a live window, which
 * can change the revision a thread without a window of its own reads
 */
export type IPollTopic = { kind: 'transitions' } | { kind: 'live' };

// what the actions modules change as the runtime runs
export type IActionsState = {
  // the runtime is closing, so nothing new is admitted or dispatched
  isClosing: boolean;
  // lifecycle evidence was lost, so every native control is quarantined
  isUnavailable: boolean;
  // the failure that stopped the event lane, which close reports
  eventFailure: unknown;
  // the ordered lane that native evidence is persisted in
  lane: Promise<void>;
  // native work the runtime owns that is still running
  ownedCount: number;
};

// what admission, dispatch, native events and reattachment share for one runtime
export type IActionsContext = {
  registry: ReturnType<typeof createProviderRegistry>;
  store: IStore;
  roots: string[];
  epoch: string;
  actionKey: Uint8Array;
  skills: ReturnType<typeof createSkills>;
  runBackground: (operation: () => Promise<void>) => Promise<void>;
  claudeTerminalOf: (nativeId: string) => ISessionTerminal | null;
  state: IActionsState;
  // the native requests waiting on an answer, by approval ID; their bodies stay in memory
  prompts: Map<string, { native: INativePrompt; threadId: string }>;
  // the native sessions this runtime controls, by live key
  controlled: Map<string, { provider: IManagedThread['provider']; nativeId: string }>;
  /*
   * Sessions a re-check after an unidentified loss left running, or skipped while an action was in
   * flight. Codex reporting one idle while its turn is recorded as active triggers the re-check a
   * lost turn end gets, since that turn's completion may have been the lost message.
   */
  watched: Set<string>;
  // providers whose event lane lost lifecycle evidence and stopped
  blockedProviders: Set<IManagedThread['provider']>;
  live: LiveItems;
  waits: ActionWaits;
  // long-polls on session transitions and live windows, bounded like IPC connections
  polls: ChangeWaits<IPollTopic>;
  // ends the waits of delayed re-checks and turn reads when the runtime closes
  resyncLifetime: AbortController;
  /** @returns The live key of a native session. */
  key(provider: IManagedThread['provider'], nativeId: string): string;
  /** Takes control of a native session's events and opens its live window. */
  own(provider: IManagedThread['provider'], nativeId: string): void;
  /** Keeps native work owned by the runtime when a requesting client disconnects. */
  runOwned(operation: () => Promise<void>): void;
};
