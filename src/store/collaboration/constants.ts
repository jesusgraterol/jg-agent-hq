// explicit projections keep bodies and authority scopes out of collection reads
export const TASK_METADATA_COLUMNS =
  'hq_collaboration_task.sequence, hq_collaboration_task.id, hq_collaboration_task.workspace_root, CAST(hq_collaboration_task.owner_operator_ref AS BLOB) AS owner_operator_ref, hq_collaboration_task.title, hq_collaboration_task.policy_revision, hq_collaboration_task.spawn_count, hq_collaboration_task.automatic_turn_count, hq_collaboration_task.state, hq_collaboration_task.lifecycle_revision, hq_collaboration_task.created_at';
export const TASK_COLUMNS = `${TASK_METADATA_COLUMNS}, policy, plan`;
export const AGENT_METADATA_COLUMNS =
  'a.sequence, a.task_id, a.agent_id, a.parent_agent_id, a.role, t.provider, t.workspace_root, a.revision, a.state, a.is_revoked, a.created_at';
export const AGENT_COLUMNS = `${AGENT_METADATA_COLUMNS}, a.permissions`;
export const GRANT_METADATA_COLUMNS =
  'sequence, id, task_id, CAST(issuer_operator_ref AS BLOB) AS issuer_operator_ref, revision, revoked_at, created_at';
export const GRANT_COLUMNS = `${GRANT_METADATA_COLUMNS}, eligible_agent_ids, skills, effects, scopes, plan`;
export const STREAM_COLUMNS =
  'sequence, id, task_id, title, purpose, creator, is_archived, created_at';
export const SUBSCRIPTION_COLUMNS =
  'sequence, task_id, stream_id, agent_id, is_active, notify, starting_sequence, read_sequence, established_by, updated_at';
export const MESSAGE_METADATA_COLUMNS =
  'm.sequence, m.id, m.task_id, m.stream_id, m.author, m.kind, CAST(m.summary AS BLOB) AS summary, m.body_bytes, m.reference_count, m.reply_to_message_id, m.created_at';
export const MESSAGE_COLUMNS = `${MESSAGE_METADATA_COLUMNS}, CAST(m.body AS BLOB) AS body, m.artifact_references`;
export const REQUEST_METADATA_COLUMNS =
  'r.id, r.task_id, r.stream_id, r.sequence, m.author AS requester, r.assignee_agent_id, r.parent_request_id, r.parent_action_id, r.child_request_ids, r.wait_generation, r.continuation_action_id, r.clarification_consumed_action_id, r.state, r.current_action_id, r.pending_action_id, r.pending_input_message_id, r.manual_dispatch_id, r.last_action_id, r.last_report_id, r.dispatch_count, r.required_authority, r.pause_agent_revision, r.dispatch_blocked_reason, r.failure_reason, r.outcome, r.created_at, r.updated_at, r.target_agent_id, r.is_claimable, r.skill_name, r.skill_mode, r.grant_id, r.grant_revision';
export const REQUEST_COLUMNS = `${REQUEST_METADATA_COLUMNS}, r.specification, r.result_references`;
export const DELIVERY_COLUMNS =
  'sequence, task_id, message_id, message_sequence, recipient_agent_id, native_action_id, delivered_at, acknowledged_at';
