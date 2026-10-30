// open native sessions are bounded independently of the durable thread collection
export const CONTROLLED_THREAD_CAPACITY = 32;

/*
 * A managed thread HQ created empty, still open and not archived, that no turn has started. Forks
 * and adopted sessions start with native history, so they never match.
 */
export const UNSTARTED_CONDITION = `active_turn_id IS NULL AND last_turn_id IS NULL AND is_archived = 0
  AND state != 'inactive' AND fork_source_thread_id IS NULL
  AND EXISTS (SELECT 1 FROM hq_action WHERE hq_action.id = hq_thread.registration_action_id
    AND hq_action.kind = 'thread-create')`;

// explicit selections keep queue bodies out of collection reads
export const THREAD_COLUMNS =
  'id, provider, native_id, native_lineage, fork_source_thread_id, is_archived, name, workspace_root, ownership, runtime_epoch, active_turn_id, last_turn_id, last_turn_state, pending_action_id, state, registration_action_id, created_at, updated_at';
export const ACTION_METADATA_COLUMNS =
  'id, digest, requested_runtime_epoch, runtime_epoch, kind, provider, control_state, thread_id, expected_turn_id, native_turn_id, native_request_id, delivery, completion, failure, related_action_id, requested_name, queue_ready, created_at, updated_at';
export const ACTION_COLUMNS = `${ACTION_METADATA_COLUMNS}, queued_input, result`;
export const EVENT_COLUMNS =
  'sequence, runtime_epoch, thread_id, action_id, native_turn_id, native_item_id, kind, created_at';
