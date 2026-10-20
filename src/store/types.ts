import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  ThreadSummarySchema,
  ManagedThreadSchema,
  ErrorKindSchema,
  type IThreadSummary,
  type IPlanMilestone,
  type IPlanReconciliationEntry,
  type IActionReceipt,
  type IManagedThread,
  type IActionSummary,
  type ILifecycleEvent,
  HqRequestSchema,
  type IActionPlanContext,
} from '../contracts/index.js';
import type { IHistoryRequest } from '../sessions/index.js';
import type { IClaudeHistoryRead } from '../providers/claude/history/index.js';

import {
  PlanWriteIntentSchema,
  PlanProjectionSchema,
  PlanProjectionPageSchema,
  PlanRevisionProjectionSchema,
  PlanRevisionPageSchema,
  type IPlanRevisionProjection,
  type IPlanWriteIntent,
  type IPlanProjection,
} from '../plans/index.js';

import {
  AdmissionSchema,
  NativeOutcomeSchema,
  NativeObservationSchema,
  ControlPageSchema,
  EventPageSchema,
  ApprovalRecordSchema,
  type IAdmission,
  type INativeOutcome,
  type INativeObservation,
  type IControlPage,
  type IEventPage,
  type IApprovalRecord,
  type IAdmissionResult,
  type IDispatch,
  type IObservationResult,
} from './control/index.js';

// worker messages are closed, bounded operations rather than arbitrary SQL
export const StoreCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claude-history'), request: HqRequestSchema }),
  z.strictObject({
    kind: z.literal('remember'),
    threads: z.array(ThreadSummarySchema).max(MAX_PAGE_SIZE),
    nextCursor: z.string().max(16_384).nullable(),
    observedAt: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal('plan-revision-project'),
    projection: PlanRevisionProjectionSchema,
  }),
  z.strictObject({ kind: z.literal('plan-revision-page'), page: PlanRevisionPageSchema }),
  z.strictObject({ kind: z.literal('thread-plan-read'), threadId: z.uuid() }),
  z.strictObject({ kind: z.literal('plan-threads'), directory: z.string() }),
  z.strictObject({ kind: z.literal('queue-peek'), threadId: z.uuid() }),
  z.strictObject({ kind: z.literal('plan-operation'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('plan-pending'), directory: z.string() }),
  z.strictObject({ kind: z.literal('plan-prepare'), intent: PlanWriteIntentSchema }),
  z.strictObject({ kind: z.literal('plan-complete'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('plan-project'), projection: PlanProjectionSchema }),
  z.strictObject({ kind: z.literal('plan-milestones'), page: PlanProjectionPageSchema }),
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
    kind: z.literal('actions'),
    threadId: z.uuid(),
    page: ControlPageSchema,
  }),
  z.strictObject({ kind: z.literal('events'), page: EventPageSchema }),
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
  z.object({ kind: z.literal('ready') }),
  z.object({
    kind: z.literal('result'),
    id: z.number().int(),
    result: z.unknown(),
    error: z.object({ message: z.string(), kind: ErrorKindSchema }).nullable(),
  }),
]);
export const StoreWorkerSchema = z.strictObject({
  databasePath: z.string().min(1),
  runtimeEpoch: z.uuid(),
  actionKey: z.instanceof(Uint8Array).refine((key) => key.length === 32),
});

// the worker owns persistence; callers cannot submit arbitrary statements
export type IStore = {
  readonly isAvailable: boolean;
  /** Refreshes one selected coordination-file projection.
   * @returns A promise resolved after projection commit.
   * @throws
   * - -1: The HQ store failed
   */
  projectPlanRevision(projection: IPlanRevisionProjection): Promise<void>;
  /** Reads a bounded revision/evidence seek page.
   * @returns A page within the response byte budget.
   * @throws
   * - -1: The HQ store failed
   */
  listPlanRevision(page: {
    directory: string;
    collection: 'sources' | 'drafts' | 'evidence' | 'correspondences';
    after: string;
    limit: number;
  }): Promise<{ data: IPlanReconciliationEntry[]; lastId: string | null; hasMore: boolean }>;
  /** Reads a thread's exact current plan binding.
   * @returns Its guided context, or null.
   * @throws
   * - -1: The HQ store failed
   */
  getThreadPlan(threadId: string): Promise<IActionPlanContext | null>;
  /** Resolves the current bounded cohort for revision shutdown.
   * @returns Managed or uncertain thread IDs.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  getPlanThreads(directory: string): Promise<string[]>;
  /** Reads the earliest retained queue entry without dispatch.
   * @returns The selected receipt, or null.
   * @throws
   * - -1: The HQ store failed
   */
  peekQueued(threadId: string): Promise<IActionReceipt | null>;
  /** Reads a selected replay identity or unfinished write intent.
   * @returns The recorded intent, or null.
   * @throws
   * - -1: The HQ store failed
   */
  getPlanOperation(id: string): Promise<IPlanWriteIntent | null>;
  /** Checks for unresolved selected-plan writes.
   * @returns The unfinished action identity, or null.
   * @throws
   * - -1: The HQ store failed
   */
  getPendingPlanOperationId(directory: string): Promise<string | null>;
  /** Admits a write identity before filesystem mutation.
   * @returns The existing identical or newly admitted intent.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  preparePlanOperation(intent: IPlanWriteIntent): Promise<IPlanWriteIntent>;
  /** Marks a confirmed file write complete without discarding its replay identity.
   * @returns A promise resolved after persistence.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  completePlanOperation(id: string): Promise<void>;
  /** Refreshes one bounded selected-plan projection.
   * @returns A promise resolved after the projection transaction.
   * @throws
   * - -1: The HQ store failed
   */
  projectPlan(projection: IPlanProjection): Promise<void>;
  /** Reads an ordinal seek page, after filesystem revision validation.
   * @returns A bounded projection page.
   * @throws
   * - -1: The HQ store failed
   */
  listPlanMilestones(page: {
    directory: string;
    limit: number;
    after: number;
  }): Promise<{ data: IPlanMilestone[]; hasMore: boolean }>;
  /**
   * Runs the Claude-owned, version-checked incremental reader in the filesystem worker.
   * @returns One history page or a private indexing marker, without persisting conversation bodies.
   * @throws
   * - -1: The HQ store failed
   * - -1: The Claude history is unavailable
   * - -1: The HQ cursor does not match this request
   */
  readClaudeHistory(command: IHistoryRequest): Promise<IClaudeHistoryRead>;
  /**
   * Persists one native discovery page without transcript bodies.
   * @returns A promise resolved after the discovery transaction commits.
   * @throws
   * - -1: The HQ store failed
   */
  remember(threads: IThreadSummary[], nextCursor: string | null): Promise<void>;
  /**
   * Reads one selected receipt, including its undelivered queued text.
   * @returns The selected receipt, or null when its UUID is unknown.
   * @throws
   * - -1: The HQ store failed
   */
  getAction(id: string): Promise<IActionReceipt | null>;
  /**
   * Reads the immutable HQ identity and current control state.
   * @returns The HQ control record, or null when its UUID is unknown.
   * @throws
   * - -1: The HQ store failed
   */
  getThread(id: string): Promise<IManagedThread | null>;
  /**
   * Resolves a case-insensitive label without granting native control.
   * @returns The matching immutable control record, or null.
   * @throws
   * - -1: The HQ store failed
   */
  getThreadByName(name: string): Promise<IManagedThread | null>;
  /**
   * Suggests an unreserved label; creation checks it again atomically.
   * @returns A currently available label.
   * @throws
   * - -1: The HQ store failed
   */
  suggestThreadName(name: string): Promise<string>;
  /**
   * Resolves the unique provider session without claiming control.
   * @returns The registered control record, or null for an external session.
   * @throws
   * - -1: The HQ store failed
   */
  getThreadByNativeId(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): Promise<IManagedThread | null>;
  /**
   * Resolves one bounded native discovery page in a single worker operation.
   * @returns The matching control records for the supplied native page.
   * @throws
   * - -1: The HQ store failed
   */
  getNativeThreads(
    provider: IManagedThread['provider'],
    nativeIds: string[],
  ): Promise<IManagedThread[]>;
  /**
   * Reads one workspace-scoped creation/UUID seek page.
   * @returns One descending page and whether another seek page exists.
   * @throws
   * - -1: The HQ store failed
   */
  listThreads(
    workspaceRoot: string,
    page: IControlPage,
  ): Promise<{ data: IManagedThread[]; hasMore: boolean }>;
  /**
   * Reads one thread-scoped seek page without queued message bodies.
   * @returns One descending metadata page and whether another seek page exists.
   * @throws
   * - -1: The HQ store failed
   */
  listActions(
    threadId: string,
    page: IControlPage,
  ): Promise<{ data: IActionSummary[]; hasMore: boolean }>;
  /**
   * Replays one thread-scoped metadata page in sequence order.
   * @returns One ascending sequence page and whether more events exist.
   * @throws
   * - -1: The HQ store failed
   */
  listEvents(page: IEventPage): Promise<{ data: ILifecycleEvent[]; hasMore: boolean }>;
  /**
   * Atomically records the digest and fences native dispatch.
   * @returns The durable receipt, current thread and the one permitted dispatch identity.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  admit(input: IAdmission): Promise<IAdmissionResult>;
  /**
   * Applies only an exact current native request acknowledgement or failure.
   * @returns The refreshed receipt, or null for an unknown action.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  applyOutcome(input: INativeOutcome): Promise<IActionReceipt | null>;
  /**
   * Applies ordered native evidence without confusing delivery with completion.
   * @returns The current thread and whether its queue may advance.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  observe(input: INativeObservation): Promise<IObservationResult>;
  /**
   * Claims one ready undelivered message for exactly one native dispatch.
   * @returns One claimed dispatch payload, or null when the queue must wait.
   * @throws
   * - -1: The HQ store failed
   */
  claimQueued(threadId: string): Promise<IDispatch | null>;
  /**
   * Records native request identity and scope fingerprint without its prompt body.
   * @returns The stable approval identity and current thread, or null for an uncontrolled turn.
   * @throws
   * - -1: The HQ store failed
   * - -1: The HQ action conflicts with its recorded state
   */
  openApproval(input: IApprovalRecord): Promise<{ id: string; thread: IManagedThread } | null>;
  /**
   * Marks native controls inactive only after proven native shutdown.
   * @returns A promise resolved after control release is committed.
   * @throws
   * - -1: The HQ store failed
   */
  releaseControls(): Promise<void>;
  /**
   * Closes SQLite and waits for the worker to exit.
   * @returns A promise resolved after SQLite closes and the worker exits.
   * @throws
   * - -1: The HQ store failed
   */
  close(): Promise<void>;
};
