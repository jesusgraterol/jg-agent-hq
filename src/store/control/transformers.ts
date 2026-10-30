import {
  PreparedInputSchema,
  TurnResultSchema,
  NativeLineageSchema,
  type IActionReceipt,
  type IActionSummary,
  type IManagedThread,
} from '../../contracts/index.js';

import type { IActionReceiptRow, IActionRow, IThreadRow } from './types.js';

/** Converts a persisted control record without leaking internal admission state. */
export const toManagedThread = (thread: IThreadRow): IManagedThread => ({
  id: thread.id,
  provider: thread.provider,
  nativeId: thread.native_id,
  forkedFromThreadId: thread.fork_source_thread_id,
  isArchived: thread.is_archived === 1,
  nativeLineage:
    thread.native_lineage === null
      ? null
      : NativeLineageSchema.parse(JSON.parse(thread.native_lineage)),
  name: thread.name,
  workspaceRoot: thread.workspace_root,
  ownership: thread.ownership,
  runtimeEpoch: thread.runtime_epoch,
  activeTurnId: thread.active_turn_id,
  state: thread.state,
  createdAt: thread.created_at,
  updatedAt: thread.updated_at,
});

/** Converts bounded action metadata without loading its pending message body. */
export const toActionSummary = (
  action: Omit<IActionRow, 'queued_input' | 'result'>,
): IActionSummary => ({
  id: action.id,
  digest: action.digest,
  runtimeEpoch: action.runtime_epoch,
  kind: action.kind,
  provider: action.provider,
  controlState: action.control_state,
  threadId: action.thread_id,
  nativeTurnId: action.native_turn_id,
  nativeRequestId: action.native_request_id,
  delivery: action.delivery,
  completion: action.completion,
  failure: action.failure,
  relatedActionId: action.related_action_id,
  createdAt: action.created_at,
  updatedAt: action.updated_at,
});

/**
 * Includes the thread's native session, recoverable queued input and complete native output only
 * for a selected receipt.
 */
export const toActionReceipt = (action: IActionReceiptRow): IActionReceipt => ({
  ...toActionSummary(action),
  nativeThreadId: action.native_thread_id,
  queuedInput:
    action.queued_input === null
      ? null
      : PreparedInputSchema.parse(JSON.parse(action.queued_input)),
  result: action.result === null ? null : TurnResultSchema.parse(JSON.parse(action.result)),
});
