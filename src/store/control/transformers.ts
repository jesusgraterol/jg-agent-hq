import type {
  IActionReceipt,
  IActionSummary,
  IManagedThread,
  INativeLineage,
  IPreparedInput,
  ITurnResult,
} from '../../contracts/index.js';

import type { IActionReceiptRow, IActionRow, IActionSummaryRow, IThreadRow } from './types.js';

/*
 * HQ writes its JSON columns from values it validated at their boundary, such as native lineage
 * and results at the adapter and queued input at admission, so they are read back as written.
 */

/** Converts a persisted control record without leaking internal admission state. */
export const toManagedThread = (thread: IThreadRow): IManagedThread => ({
  id: thread.id,
  provider: thread.provider,
  nativeId: thread.native_id,
  nativeLineage:
    thread.native_lineage === null ? null : (JSON.parse(thread.native_lineage) as INativeLineage),
  name: thread.name,
  workspaceRoot: thread.workspace_root,
  ownership: thread.ownership,
  runtimeEpoch: thread.runtime_epoch,
  activeTurnId: thread.active_turn_id,
  state: thread.state,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
});

/** Converts the action metadata receipts and summaries share. */
const toActionMetadata = (
  action: Omit<IActionRow, 'queued_input' | 'result'>,
): Omit<IActionSummary, 'queuedText'> => ({
  id: action.id,
  digest: action.digest,
  runtimeEpoch: action.runtime_epoch,
  kind: action.kind,
  provider: action.provider,
  threadId: action.thread_id,
  nativeTurnId: action.native_turn_id,
  phase: action.phase,
  delivery: action.delivery,
  completion: action.completion,
  failure: action.failure,
  relatedActionId: action.related_action_id,
  createdAt: action.created_at,
  updatedAt: action.updated_at,
});

/** Converts bounded action metadata with the text of its undelivered queued input, uncut. */
export const toActionSummary = (action: IActionSummaryRow): IActionSummary => ({
  ...toActionMetadata(action),
  queuedText: action.queued_text === null ? null : { text: action.queued_text, isTruncated: false },
});

/**
 * Includes the thread's native session, recoverable queued input and complete native output only
 * for a selected receipt.
 */
export const toActionReceipt = (action: IActionReceiptRow): IActionReceipt => ({
  ...toActionMetadata(action),
  nativeThreadId: action.native_thread_id,
  queuedInput:
    action.queued_input === null ? null : (JSON.parse(action.queued_input) as IPreparedInput),
  result: action.result === null ? null : (JSON.parse(action.result) as ITurnResult),
});
