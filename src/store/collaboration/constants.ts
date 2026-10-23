// explicit projections keep bodies and authority scopes out of collection reads
export const TASK_METADATA_COLUMNS =
  'sequence, id, workspace_root, owner_operator_ref, title, policy_revision, spawn_count, state, lifecycle_revision, created_at';
export const TASK_COLUMNS = `${TASK_METADATA_COLUMNS}, policy, plan`;
export const AGENT_METADATA_COLUMNS =
  'a.sequence, a.task_id, a.agent_id, a.parent_agent_id, a.role, t.provider, t.workspace_root, a.revision, a.state, a.is_revoked, a.created_at';
export const AGENT_COLUMNS = `${AGENT_METADATA_COLUMNS}, a.permissions`;
export const GRANT_METADATA_COLUMNS =
  'sequence, id, task_id, issuer_operator_ref, revision, revoked_at, created_at';
export const GRANT_COLUMNS = `${GRANT_METADATA_COLUMNS}, eligible_agent_ids, skills, effects, scopes, plan`;
export const STREAM_COLUMNS =
  'sequence, id, task_id, title, purpose, creator, is_archived, created_at';
export const SUBSCRIPTION_COLUMNS =
  'sequence, task_id, stream_id, agent_id, is_active, notify, starting_sequence, read_sequence, established_by, updated_at';
export const MESSAGE_METADATA_COLUMNS =
  'm.sequence, m.id, m.task_id, m.stream_id, m.author, m.kind, m.summary, m.body_bytes, m.reference_count, m.reply_to_message_id, m.created_at';
export const MESSAGE_COLUMNS = `${MESSAGE_METADATA_COLUMNS}, m.body, m.artifact_references`;
export const REQUEST_METADATA_COLUMNS =
  'r.id, r.task_id, r.stream_id, r.sequence, m.author AS requester, r.assignee_agent_id, r.state, r.current_action_id, r.outcome, r.created_at, r.updated_at, r.target_agent_id, r.is_claimable, r.skill_name, r.skill_mode, r.grant_id, r.grant_revision';
export const REQUEST_COLUMNS = `${REQUEST_METADATA_COLUMNS}, r.specification, r.result_references`;
export const DELIVERY_COLUMNS =
  'sequence, task_id, message_id, message_sequence, recipient_agent_id, native_action_id, delivered_at, acknowledged_at';
