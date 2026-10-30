import type { IHistoryItem, ISessionSettings } from '../../../contracts/index.js';
import type { INativeObservation } from '../../../store/control/index.js';
import type { INativePrompt, IProviderSkills, IAgentProviderOutcome } from '../../index.js';

// normalized Claude evidence is consumed by the existing action and live-window owners
export type IClaudeControlEvents = {
  observe(observation: INativeObservation): void;
  item(nativeId: string, item: IHistoryItem, isComplete: boolean, replacedIds?: string[]): void;
  gap(nativeId: string): void;
  delta(nativeId: string, turnId: string, itemId: string, text: string): void;
  prompt(prompt: INativePrompt): void;
  outcome(outcome: IAgentProviderOutcome): void;
  unavailable(nativeId: string): void;
};

// per-process ownership and bounded native correlation metadata
export type IClaudeInput = {
  id: string;
  requestId: string;
  isAcknowledged: boolean;
  interruptRequested: boolean;
  hasInterruptionMarker: boolean;
  finalText: string | null;
  isOutputOversized: boolean;
  resolve(turn: { id: string }): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};
export type IClaudeSession = {
  id: string;
  workspaceRoot: string;
  settings: ISessionSettings;
  scope: string;
  isClosing: boolean;
  hasInput: boolean;
  connection?: Awaited<ReturnType<typeof import('../rpc.js').createClaudeRpc>>;
  opening: Promise<void>;
  skills?: IProviderSkills | null;
  input?: IClaudeInput;
  apiMessageId?: string;
  previews: Map<number, { id: string; type: string }>;
  // what an idle session answers with while it has no process, until input reopens it
  parked?: { configuration: unknown; agents: unknown; permissionMode: unknown };
  // cancels the wait that parks the session after its idle period
  idleStop?: AbortController;
  // a park or a reopen in progress, which every other call waits for
  transition?: Promise<void>;
  requests: Map<
    string,
    { toolId: string | null; scopedId: string; fingerprint: string; isWritten: boolean }
  >;
};
