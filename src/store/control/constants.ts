// open native sessions are bounded independently of the durable thread collection
export const CONTROLLED_THREAD_CAPACITY = 32;

/*
 * A managed thread HQ created empty and still open, that no turn has started. Adopted sessions
 * start with native history, so they never match.
 */
export const UNSTARTED_CONDITION = `active_turn_id IS NULL AND last_turn_id IS NULL
  AND state != 'inactive'
  AND EXISTS (SELECT 1 FROM agent_hq_action WHERE agent_hq_action.id = agent_hq_thread.registration_action_id
    AND agent_hq_action.kind = 'thread-create')`;

/*
 * A managed Codex session with no action in flight. Codex runs sessions in its shared daemon,
 * which outlives the runtime, so a runtime leaves such a session bound to itself at shutdown, and
 * the next one rejoins it instead of marking its ownership uncertain.
 */
export const KEPT_SESSION_CONDITION = `ownership = 'managed' AND native_id IS NOT NULL
  AND pending_action_id IS NULL AND provider = 'codex'`;

// explicit selections keep queue bodies out of collection reads
export const THREAD_COLUMNS =
  'id, provider, native_id, native_lineage, name, workspace_root, ownership, runtime_epoch, active_turn_id, last_turn_id, last_turn_state, pending_action_id, state, registration_action_id, created_at, updated_at';
export const ACTION_METADATA_COLUMNS =
  'id, digest, requested_runtime_epoch, runtime_epoch, kind, provider, thread_id, expected_turn_id, native_turn_id, phase, delivery, completion, failure, related_action_id, requested_name, queue_ready, created_at, updated_at';
export const ACTION_COLUMNS = `${ACTION_METADATA_COLUMNS}, queued_input, result`;
// a receipt's columns, with its thread's native session read by the thread's primary key
export const ACTION_RECEIPT_COLUMNS = `${ACTION_COLUMNS}, (SELECT native_id FROM agent_hq_thread WHERE agent_hq_thread.id = agent_hq_action.thread_id) AS native_thread_id,
  (SELECT json_object('actionId', action_id, 'threadId', thread_id,
    'sourceWorkspaceRoot', source_workspace_root, 'targetWorkspaceRoot', target_workspace_root,
    'historyWorkspaceRoot', history_workspace_root, 'state', state,
    'createdAt', created_at, 'updatedAt', updated_at)
  FROM agent_hq_workspace_transition WHERE action_id = agent_hq_action.id) AS workspace_transition`;
