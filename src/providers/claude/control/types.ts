import type { IEvidenceItem, IHistoryItem, ISessionSettings } from '../../../contracts/index.js';
import type { IAgentProviderEvents, IProviderSkills } from '../../index.js';

// normalized Claude evidence is consumed by the existing action and live-window owners
export type IClaudeControlEvents = Pick<
  IAgentProviderEvents,
  'observe' | 'item' | 'gap' | 'background' | 'delta' | 'prompt' | 'outcome' | 'unavailable'
> &
  Partial<Pick<IAgentProviderEvents, 'quarantined' | 'quiescent'>>;

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

// a turn Claude starts with no HQ input, such as after a background command finishes
export type IClaudeNativeTurn = {
  id: string;
  interruptRequested: boolean;
  hasInterruptionMarker: boolean;
};

/*
 * Text HQ wrote into an active turn, which Claude replays once it takes it in: within that turn,
 * at its next tool boundary, or after the turn's result, when it runs as the session's next turn.
 * Saved input can also acknowledge it, retaining this identity for a later replay. The timer
 * releases it after the turn ended and rejects it only when delivery remains unconfirmed.
 */
export type IClaudeSteer = {
  id: string;
  turnId: string;
  inputSha256: string;
  isAcknowledged: boolean;
  resolve(turnId: string): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
};

// saved item/evidence identities, after the native reader validates the transcript and chain
export type IClaudeSavedInput = Pick<IHistoryItem, 'kind' | 'provenance'> &
  (Pick<IHistoryItem, 'turnId'> | Pick<IEvidenceItem, 'reference'>);

// the turn the session's frames belong to: an acknowledged HQ input or a turn Claude started
export type IClaudeTurn = IClaudeInput | IClaudeNativeTurn;

// fast mode as Claude last reported it, on, cooling down after a rate limit, or off with a reason
export type IClaudeFastMode = {
  state: 'on' | 'cooldown' | 'off';
  disabledReason: string | null;
};
export type IClaudeSession = {
  id: string;
  workspaceRoot: string;
  settings: ISessionSettings;
  scope: string;
  isClosing: boolean;
  // an admitted close owns release even if automatic shutdown began first
  releaseActionId?: string;
  // a semantic failure suspends HQ interpretation without ending this native process
  isQuarantined?: boolean;
  // independent lifecycle proof belongs to this process generation, never its transcript
  monitor?: ReturnType<typeof import('./quarantine.js').createClaudeQuarantineMonitor>;
  quiescentRevision?: number;
  nativeStartedAt?: number;
  hasInput: boolean;
  // whether the current process resumed its conversation, whose recorded instructions Claude reuses
  isResumed: boolean;
  connection?: Awaited<ReturnType<typeof import('../rpc.js').createClaudeRpc>>;
  opening: Promise<void>;
  skills?: IProviderSkills | null;
  input?: IClaudeInput;
  nativeTurn?: IClaudeNativeTurn;
  // steers written into an active turn that Claude hasn't replayed yet, by their message UUID
  steers: Map<string, IClaudeSteer>;
  // exact live replays retained only within this process generation for late turn results
  replayedSteers?: Set<string>;
  // how many background commands Claude last reported running, which keep the session from parking
  backgroundTaskCount: number;
  // read from Claude's start and turn results, and kept while the session is parked
  fastMode?: IClaudeFastMode;
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
