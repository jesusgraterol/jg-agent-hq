import {
  NativeSkillInputSchema,
  type IActionReceipt,
  type IActionSummary,
  type IManagedThread,
} from '../../contracts/index.js';

import type { IActionRow, IThreadRow } from './types.js';

/** Converts a persisted control record without leaking internal admission state. */
export const toManagedThread = (thread: IThreadRow): IManagedThread => ({
  id: thread.id,
  provider: thread.provider,
  nativeId: thread.native_id,
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
  action: Omit<IActionRow, 'queued_text' | 'queued_skill'>,
): IActionSummary => ({
  id: action.id,
  digest: action.digest,
  runtimeEpoch: action.runtime_epoch,
  kind: action.kind,
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

/** Includes recoverable queued text only for a selected receipt. */
export const toActionReceipt = (action: IActionRow): IActionReceipt => ({
  ...toActionSummary(action),
  queuedText: action.queued_text,
  queuedSkill:
    action.queued_skill === null
      ? null
      : NativeSkillInputSchema.parse(JSON.parse(action.queued_skill)),
});
