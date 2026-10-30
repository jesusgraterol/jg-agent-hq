import { z } from 'zod';
import {
  BrowserActionSchema,
  BrowserReceiptSchema,
  type IBrowserAction,
  type IBrowserReceipt,
  MAX_PAGE_SIZE,
  ThreadSummarySchema,
  ManagedThreadSchema,
  ErrorKindSchema,
  type IThreadSummary,
  type IActionReceipt,
  type IManagedThread,
  type IActionSummary,
  type INativeApprovalSummary,
  type ILifecycleEvent,
  HqRequestSchema,
  type IHistoryProvenance,
  SessionStateSchema,
  type ISessionState,
  type ISessionTransition,
} from '../contracts/index.js';
import type { IHistoryRequest } from '../sessions/index.js';
import {
  EvidenceOriginsRequestSchema,
  type IEvidenceOriginsRequest,
} from '../sessions/evidence/index.js';
import type { IClaudeHistoryRead } from '../providers/claude/history/index.js';
import { StorageDescriptorSchema, type IStorageDescriptor } from '../storage/index.js';

import {
  AdmissionSchema,
  NativeOutcomeSchema,
  NativeObservationSchema,
  ControlPageSchema,
  ApprovalPageRequestSchema,
  EventPageSchema,
  ApprovalRecordSchema,
  type IAdmission,
  type INativeOutcome,
  type INativeObservation,
  type IControlPage,
  type IApprovalPageRequest,
  type IEventPage,
  type IApprovalRecord,
  type IAdmissionResult,
  type IDispatch,
  type IObservationResult,
} from './control/index.js';
import type { IActiveSessionRecord } from './sessions/index.js';

// worker messages are closed, bounded operations rather than arbitrary SQL
export const StoreCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evidence-origins'), request: EvidenceOriginsRequestSchema }),
  z.strictObject({ kind: z.literal('storage-maintenance') }),
  z.strictObject({ kind: z.literal('snapshot-backup'), destination: z.string() }),
  z.strictObject({
    kind: z.literal('browser-read'),
    id: z.uuid(),
    operatorId: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal('browser-admit'),
    action: BrowserActionSchema,
    operatorId: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal('browser-settle'),
    id: z.uuid(),
    operatorId: z.string().min(1).max(256),
    state: BrowserReceiptSchema.shape.state.exclude(['submitted']),
  }),
  z.strictObject({ kind: z.literal('claude-history'), request: HqRequestSchema }),
  z.strictObject({
    kind: z.literal('remember'),
    threads: z.array(ThreadSummarySchema).max(MAX_PAGE_SIZE),
    nextCursor: z.string().max(16_384).nullable(),
    observedAt: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal('sessions-observe'),
    provider: z.string(),
    sessions: z
      .array(z.strictObject({ nativeId: z.string().min(1), state: SessionStateSchema }))
      .max(1024),
    isComplete: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('sessions-unknown'), provider: z.string() }),
  z.strictObject({
    kind: z.literal('sessions-states'),
    provider: z.string(),
    nativeIds: z.array(z.string()).max(MAX_PAGE_SIZE),
  }),
  z.strictObject({
    kind: z.literal('session-transitions'),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(128),
  }),
  z.strictObject({ kind: z.literal('sessions-active'), limit: z.number().int().min(1).max(128) }),
  z.strictObject({ kind: z.literal('close') }),
  z.strictObject({ kind: z.literal('action-read'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('thread-read'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('thread-name-read'), name: z.string().min(1).max(32) }),
  z.strictObject({ kind: z.literal('thread-name-suggest'), name: ManagedThreadSchema.shape.name }),
  z.strictObject({
    kind: z.literal('native-thread-read'),
    provider: ManagedThreadSchema.shape.provider,
    nativeId: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('native-threads'),
    provider: ManagedThreadSchema.shape.provider,
    nativeIds: z.array(z.string().min(1).max(4096)).max(128),
  }),
  z.strictObject({
    kind: z.literal('threads'),
    workspaceRoot: z.string().min(1),
    page: ControlPageSchema,
  }),
  z.strictObject({
    kind: z.literal('thread-unstarted'),
    provider: ManagedThreadSchema.shape.provider,
    nativeId: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('threads-unstarted'),
    provider: ManagedThreadSchema.shape.provider,
    workspaceRoot: z.string().min(1),
    limit: z.number().int().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal('actions'),
    threadId: z.uuid(),
    page: ControlPageSchema,
  }),
  z.strictObject({
    kind: z.literal('provider-actions'),
    provider: ManagedThreadSchema.shape.provider,
    page: ControlPageSchema,
  }),
  z.strictObject({ kind: z.literal('events'), page: EventPageSchema }),
  z.strictObject({
    kind: z.literal('approvals'),
    threadId: z.uuid(),
    page: ApprovalPageRequestSchema,
  }),
  z.strictObject({ kind: z.literal('admit'), input: AdmissionSchema }),
  z.strictObject({ kind: z.literal('outcome'), input: NativeOutcomeSchema }),
  z.strictObject({ kind: z.literal('observe'), input: NativeObservationSchema }),
  z.strictObject({ kind: z.literal('claim-queue'), threadId: z.uuid() }),
  z.strictObject({ kind: z.literal('approval'), input: ApprovalRecordSchema }),
  z.strictObject({ kind: z.literal('release') }),
]);
export type IStoreCommand = z.infer<typeof StoreCommandSchema>;
export const StoreRequestSchema = z.strictObject({
  id: z.number().int(),
  command: StoreCommandSchema,
});
export const StoreResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), storage: StorageDescriptorSchema }),
  z.object({
    kind: z.literal('startup-error'),
    error: z.object({ code: z.string(), message: z.string(), kind: ErrorKindSchema }),
  }),
  z.object({
    kind: z.literal('result'),
    id: z.number().int(),
    result: z.unknown(),
    error: z
      .object({ code: z.string().min(1).max(128), message: z.string(), kind: ErrorKindSchema })
      .nullable(),
  }),
]);
export const StoreWorkerSchema = z.strictObject({
  databasePath: z.string().min(1),
  runtimeEpoch: z.uuid(),
  actionKey: z.instanceof(Uint8Array).refine((key) => key.length === 32),
});

// the worker owns persistence; callers cannot submit arbitrary statements
export type IStore = {
  /** Correlates native input identities and hashes with durable host submissions.
   * @returns Exact historical provenance or null for each selected item.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getEvidenceOrigins(command: IEvidenceOriginsRequest): Promise<(IHistoryProvenance | null)[]>;
  readonly isAvailable: boolean;
  storage: IStorageDescriptor;
  /**
   * Drains earlier worker commands and checks for unresolved native work.
   * @returns Whether a host maintenance callback can start.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  prepareStorageMaintenance(): Promise<boolean>;
  /**
   * Copies the worker's database through SQLite's WAL-aware backup API.
   * Local backup completion has no metadata-command deadline; maintenance stays held until it settles.
   * @returns Completion after the backup connection has closed.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  snapshotBackup(destination: string): Promise<void>;
  /**
   * Reads the operator-owned browser receipt.
   * @returns The receipt or null.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getBrowserAction(id: string, operatorId: string): Promise<IBrowserReceipt | null>;
  /**
   * Admits one browser effect.
   * @returns Its durable receipt and dispatch ownership.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  admitBrowserAction(
    action: IBrowserAction,
    operatorId: string,
  ): Promise<{ receipt: IBrowserReceipt; isNew: boolean }>;
  /**
   * Settles a submitted effect.
   * @returns Its receipt.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  settleBrowserAction(
    id: string,
    operatorId: string,
    state: 'acknowledged' | 'uncertain',
  ): Promise<IBrowserReceipt | null>;
  /** Records observed states of sessions HQ doesn't manage; complete observations close omissions.
   * @returns A promise resolved after the transaction commits.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  observeSessions(
    provider: string,
    sessions: { nativeId: string; state: ISessionState }[],
    isComplete: boolean,
  ): Promise<void>;
  /** Marks a provider's open observed sessions unknown after its native connection was lost.
   * @returns A promise resolved after the update commits.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  markSessionsUnknown(provider: string): Promise<void>;
  /** Reads the live states of selected native sessions, managed or observed.
   * @returns The sessions HQ manages or has observed, without the others.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getSessionStates(
    provider: string,
    nativeIds: string[],
  ): Promise<{ nativeId: string; state: ISessionState }[]>;
  /** Reads session transitions after a sequence, in order.
   * @returns A bounded page, whether more transitions follow, the highest sequence ever issued and
   * whether the sequence can't be continued exactly.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listSessionTransitions(
    afterSequence: number,
    limit: number,
  ): Promise<{
    data: ISessionTransition[];
    hasMore: boolean;
    latestSequence: number;
    isReset: boolean;
  }>;
  /** Reads running and waiting sessions, managed and observed, newest state change first.
   * @returns At most `limit` records and whether more sessions are active.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listActiveSessions(
    limit: number,
  ): Promise<{ data: IActiveSessionRecord[]; isTruncated: boolean }>;
  /**
   * Runs the Claude-owned identity-checked incremental reader in the filesystem worker.
   * @returns One history page or a private indexing marker, without persisting conversation bodies.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   */
  readClaudeHistory(command: IHistoryRequest): Promise<IClaudeHistoryRead>;
  /**
   * Persists one native discovery page without transcript bodies.
   * @returns A promise resolved after the discovery transaction commits.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  remember(threads: IThreadSummary[], nextCursor: string | null): Promise<void>;
  /**
   * Reads one selected receipt, including its undelivered queued text.
   * @returns The selected receipt, or null when its UUID is unknown.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getAction(id: string): Promise<IActionReceipt | null>;
  /**
   * Reads the immutable HQ identity and current control state.
   * @returns The HQ control record, or null when its UUID is unknown.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getThread(id: string): Promise<IManagedThread | null>;
  /**
   * Resolves a case-insensitive label without granting native control.
   * @returns The matching immutable control record, or null.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getThreadByName(name: string): Promise<IManagedThread | null>;
  /**
   * Suggests an unreserved label; creation checks it again atomically.
   * @returns A currently available label.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  suggestThreadName(name: string): Promise<string>;
  /**
   * Resolves the unique provider session without claiming control.
   * @returns The registered control record, or null for an external session.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getThreadByNativeId(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): Promise<IManagedThread | null>;
  /**
   * Resolves one bounded native discovery page in a single worker operation.
   * @returns The matching control records for the supplied native page.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getNativeThreads(
    provider: IManagedThread['provider'],
    nativeIds: string[],
  ): Promise<IManagedThread[]>;
  /**
   * Reads one workspace-scoped creation/UUID seek page.
   * @returns One descending page and whether another seek page exists.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listThreads(
    workspaceRoot: string,
    page: IControlPage,
  ): Promise<{ data: IManagedThread[]; hasMore: boolean }>;
  /**
   * Reads one provider's managed threads in a workspace that no turn has started, newest first.
   * @returns At most `limit` threads and whether more exist.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listUnstartedThreads(
    provider: string,
    workspaceRoot: string,
    limit: number,
  ): Promise<{ data: IManagedThread[]; isTruncated: boolean }>;
  /**
   * Reads a managed thread by its native ID when no turn has started it.
   * @returns The thread, or null when none is registered or a turn has started.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  getUnstartedThread(provider: string, nativeId: string): Promise<IManagedThread | null>;
  /**
   * Reads one thread-scoped seek page without queued message bodies.
   * @returns One descending metadata page and whether another seek page exists.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listActions(
    threadId: string,
    page: IControlPage,
  ): Promise<{ data: IActionSummary[]; hasMore: boolean }>;
  /**
   * Reads indexed global provider actions, including authentication receipts.
   * @returns One descending seek page without queued input or result bodies.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listProviderActions(
    provider: string,
    page: IControlPage,
  ): Promise<{ data: IActionSummary[]; hasMore: boolean }>;
  /**
   * Reads durable approval metadata with an optional state filter.
   * @returns One descending seek page without prompt bodies or answers.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listApprovals(
    threadId: string,
    page: IApprovalPageRequest,
  ): Promise<{ data: INativeApprovalSummary[]; hasMore: boolean }>;
  /**
   * Replays one thread-scoped metadata page in sequence order.
   * @returns One ascending sequence page and whether more events exist.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  listEvents(page: IEventPage): Promise<{ data: ILifecycleEvent[]; hasMore: boolean }>;
  /**
   * Atomically records the digest and fences native dispatch.
   * @returns The durable receipt, current thread and the one permitted dispatch identity.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  admit(input: IAdmission): Promise<IAdmissionResult>;
  /**
   * Applies only an exact current native request acknowledgement or failure.
   * @returns The refreshed receipt, or null for an unknown action.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  applyOutcome(input: INativeOutcome): Promise<IActionReceipt | null>;
  /**
   * Applies ordered native evidence without confusing delivery with completion.
   * @returns The current thread and whether its queue may advance.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  observe(input: INativeObservation): Promise<IObservationResult>;
  /**
   * Claims one ready undelivered message for exactly one native dispatch.
   * @returns One claimed dispatch payload, or null when the queue must wait.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  claimQueued(threadId: string): Promise<IDispatch | null>;
  /**
   * Records native request identity and scope fingerprint without its prompt body.
   * @returns The stable approval identity and current thread, or null for an uncontrolled turn.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  openApproval(input: IApprovalRecord): Promise<{ id: string; thread: IManagedThread } | null>;
  /**
   * Marks native controls inactive only after proven native shutdown.
   * @returns A promise resolved after control release is committed.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  releaseControls(): Promise<void>;
  /**
   * Closes SQLite and waits for the worker to exit.
   * @returns A promise resolved after SQLite closes and the worker exits.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  close(): Promise<void>;
};
