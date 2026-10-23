// open native sessions are bounded independently of the durable thread collection
export const CONTROLLED_THREAD_CAPACITY = 32;

// explicit selections keep queue bodies out of collection reads
export const THREAD_COLUMNS =
  'id, provider, native_id, native_lineage, fork_source_thread_id, is_archived, name, workspace_root, ownership, runtime_epoch, active_turn_id, last_turn_id, last_turn_state, pending_action_id, state, registration_action_id, created_at, updated_at';
export const ACTION_METADATA_COLUMNS =
  'id, digest, requested_runtime_epoch, runtime_epoch, kind, thread_id, expected_turn_id, native_turn_id, native_request_id, delivery, completion, failure, related_action_id, plan_context, requested_name, queue_ready, created_at, updated_at';
export const ACTION_COLUMNS = `${ACTION_METADATA_COLUMNS}, queued_text, queued_skill`;
export const EVENT_COLUMNS =
  'sequence, runtime_epoch, thread_id, action_id, native_turn_id, native_item_id, kind, created_at';
