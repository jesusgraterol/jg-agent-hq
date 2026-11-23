// open native sessions are bounded independently of the durable thread collection
export const CONTROLLED_THREAD_CAPACITY = 32;

/*
 * Autonomous Claude turns have no input action. Their saved steer inherits the last acknowledged
 * input from the same controller epoch; an intervening resume/adopt/recover fences that anchor.
 */
export const CLAUDE_STEER_TURN_CONDITION = `(a.native_turn_id = ? OR a.id = ? OR (
  length(a.native_turn_id) = 36
  AND a.native_turn_id LIKE '________-____-4___-____-____________'
  AND lower(substr(a.native_turn_id, 20, 1)) IN ('8', '9', 'a', 'b')
  AND lower(replace(a.native_turn_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
  AND NOT EXISTS (SELECT 1 FROM agent_hq_action target
    WHERE target.thread_id = a.thread_id AND target.phase = 'turn'
      AND target.native_turn_id = a.native_turn_id)
  AND ? = (SELECT CASE WHEN anchor.phase = 'turn' THEN anchor.native_turn_id END
    FROM agent_hq_action anchor
    WHERE anchor.thread_id = a.thread_id AND anchor.runtime_epoch = a.runtime_epoch
      AND anchor.created_at < a.created_at AND anchor.delivery = 'acknowledged'
      AND anchor.kind IN ('message', 'queue', 'thread-create', 'thread-resume', 'thread-adopt', 'thread-recover')
    ORDER BY anchor.created_at DESC, anchor.id DESC LIMIT 1)
))`;

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
export const ACTION_RECEIPT_COLUMNS = `${ACTION_COLUMNS}, (SELECT native_id FROM agent_hq_thread WHERE agent_hq_thread.id = agent_hq_action.thread_id) AS native_thread_id`;
