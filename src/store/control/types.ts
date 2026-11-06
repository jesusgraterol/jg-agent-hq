import type {
  IActionEnvelope,
  IActionPhase,
  IActionReceipt,
  IActionSummary,
  IManagedThread,
  INativeApproval,
  INativeApprovalSummary,
  INativeLineage,
  IPreparedInput,
  IProviderId,
  ITurnResult,
} from '../../contracts/index.js';

// these shapes mirror SQLite columns; transformations retain the public camelCase contracts
export type IThreadRow = {
  id: string;
  provider: IManagedThread['provider'];
  native_id: string | null;
  native_lineage: string | null;
  name: string;
  workspace_root: string;
  ownership: IManagedThread['ownership'];
  runtime_epoch: string | null;
  active_turn_id: string | null;
  last_turn_id: string | null;
  last_turn_state: IActionReceipt['completion'];
  pending_action_id: string | null;
  state: IManagedThread['state'];
  registration_action_id: string;
  created_at: number;
  updated_at: number;
};
export type IActionRow = {
  id: string;
  digest: string;
  requested_runtime_epoch: string;
  runtime_epoch: string;
  kind: IActionReceipt['kind'];
  provider: IActionReceipt['provider'];
  thread_id: string | null;
  expected_turn_id: string | null;
  native_turn_id: string | null;
  phase: IActionPhase | null;
  delivery: IActionReceipt['delivery'];
  completion: IActionReceipt['completion'];
  failure: IActionReceipt['failure'];
  related_action_id: string | null;
  queued_input: string | null;
  result: string | null;
  requested_name: string | null;
  queue_ready: number;
  created_at: number;
  updated_at: number;
};
// an action row joined with its thread's native session, which its receipt carries
export type IActionReceiptRow = IActionRow & { native_thread_id: string | null };
// an action's metadata with the text of its undelivered queued input, which a page carries
export type IActionSummaryRow = Omit<IActionRow, 'queued_input' | 'result'> & {
  queued_text: string | null;
};

// an outcome answers the phase its action took; one for a phase the action has left is stale
type IOutcomeFields = { actionId: string; phase: IActionPhase };
export type INativeOutcome = IOutcomeFields &
  (
    | { kind: 'created'; nativeId: string; nativeLineage: INativeLineage | null }
    | {
        kind: 'resumed';
        nativeState: 'notLoaded' | 'idle' | 'systemError' | 'active' | 'unknown';
        nativeLineage: INativeLineage | null;
        // an explicit known-session join is acknowledged only after its turn was verified twice
        latestTurn?: IReattachment['latestTurn'];
      }
    | { kind: 'closed' }
    | { kind: 'cleaned' }
    // the native session named by its ID is gone, with its records
    | { kind: 'deleted'; nativeId: string }
    | { kind: 'renamed' }
    | { kind: 'turn-accepted'; nativeTurnId: string }
    | { kind: 'steer-accepted'; nativeTurnId: string }
    | { kind: 'interrupt-accepted' }
    | { kind: 'reply-written' }
    | { kind: 'uncertain' }
    | { kind: 'failed'; failure: NonNullable<IActionReceipt['failure']> }
  );

type INativeTurnFields = { provider: IProviderId; nativeThreadId: string; nativeTurnId: string };
// native evidence that changes durable state; live items stay in the runtime's memory
export type INativeObservation =
  | ({ kind: 'turn-started' } & INativeTurnFields)
  | ({
      kind: 'turn-completed';
      state: NonNullable<IActionReceipt['completion']>;
      result?: ITurnResult;
    } & INativeTurnFields)
  | {
      kind: 'request-resolved' | 'request-canceled';
      provider: IProviderId;
      nativeThreadId: string;
      requestId: string;
    }
  | { kind: 'native-unavailable'; provider: IProviderId; nativeThreadId?: string };

// only validated derivations of trusted configuration/native metadata reach admission
export type IAdmission = {
  action: IActionEnvelope;
  prepared: {
    workspaceRoot?: string;
    nativeId?: string;
    input?: IPreparedInput;
    recoveryTurn?: IReattachment['latestTurn'];
  };
};
export type IAdmissionResult = {
  receipt: IActionReceipt;
  thread: IManagedThread | null;
  isNew: boolean;
  dispatchActionId: string | null;
};
export type IDispatch = { receipt: IActionReceipt; thread: IManagedThread; input: IPreparedInput };
/*
 * The refreshed thread, whether its queue may advance, and an action the observation moved to
 * its next phase, such as a close whose interrupted turn ended, which dispatch continues.
 */
export type IObservationResult = {
  thread: IManagedThread | null;
  canDispatchQueued: boolean;
  continued?: IActionReceipt | null;
};

// a session another runtime left running, with its latest turn as its native process reports it
export type IReattachment = {
  threadId: string;
  // only a cohort captured before a live connection loss may rejoin within the current runtime
  isReconnect?: boolean;
  latestTurn: {
    nativeTurnId: string;
    state: 'running' | 'completed' | 'failed' | 'interrupted';
  } | null;
};

// the turns a session recorded, which a live re-check compares with what its native process reports
export type ITurnRecord = {
  threadId: string;
  workspaceRoot: string;
  activeTurnId: string | null;
  lastTurnId: string | null;
  // an action is in flight, so the session's newest turn may not be recorded yet
  hasPendingAction: boolean;
};

// public cursors are decoded and query-bound before these trusted seek positions are sent
export type IControlPage = {
  limit: number;
  position: { createdAt: number; id: string } | null;
};
export type IApprovalPageRequest = IControlPage & { state?: INativeApprovalSummary['state'] };

export type IApprovalRecord = {
  provider: IProviderId;
  id: string;
  nativeThreadId: string;
  nativeTurnId: string;
  requestId: string;
  kind: INativeApproval['kind'];
  digest: string;
  isBlocking: boolean;
};

// bounded read results omit queued bodies in collection responses
export type IThreadPage = { data: IManagedThread[]; hasMore: boolean };
export type IActionPage = { data: IActionSummary[]; hasMore: boolean };
export type IApprovalPage = { data: INativeApprovalSummary[]; hasMore: boolean };
