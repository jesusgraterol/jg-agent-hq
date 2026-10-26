CREATE TABLE hq_schema (
  id INTEGER NOT NULL CONSTRAINT hq_pk_schema__id PRIMARY KEY CHECK (id = 1),
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64),
  action_key_hash TEXT NOT NULL CHECK (length(action_key_hash) = 64),
  package_version TEXT NOT NULL CHECK (length(package_version) BETWEEN 1 AND 64)
) STRICT;

CREATE TABLE hq_native_history_index (
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  native_id TEXT NOT NULL CHECK (length(native_id) > 0),
  workspace_root TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  native_state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  runtime_epoch TEXT NOT NULL,
  continuation_cursor TEXT,
  CONSTRAINT hq_pk_nhi__provider_native_id PRIMARY KEY (provider, native_id)
) STRICT;

CREATE INDEX hq_idx_nhi__provider_workspace_root_created_at_native_id
ON hq_native_history_index (provider, workspace_root, created_at DESC, native_id DESC);

CREATE TABLE hq_thread (
  id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  native_id TEXT CHECK (native_id IS NULL OR length(native_id) > 0),
  native_lineage TEXT CHECK (native_lineage IS NULL OR json_valid(native_lineage)),
  fork_source_thread_id TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  name TEXT NOT NULL COLLATE NOCASE,
  workspace_root TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'uncertain')),
  runtime_epoch TEXT,
  active_turn_id TEXT,
  last_turn_id TEXT,
  last_turn_state TEXT CHECK (last_turn_state IS NULL OR last_turn_state IN ('completed', 'failed', 'interrupted')),
  pending_action_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating', 'inactive', 'idle', 'starting', 'running', 'waiting-input', 'waiting-approval', 'stopping', 'completed', 'failed', 'interrupted', 'unknown')),
  registration_action_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_pk_t__id PRIMARY KEY (id),
  CONSTRAINT hq_fk_t__fork_source_thread_id FOREIGN KEY (fork_source_thread_id) REFERENCES hq_thread(id),
  CONSTRAINT hq_uq_t__provider_native_id UNIQUE (provider, native_id),
  CONSTRAINT hq_uq_t__name UNIQUE (name),
  CONSTRAINT hq_uq_t__pending_action_id UNIQUE (pending_action_id),
  CONSTRAINT hq_fk_t__registration_action_id FOREIGN KEY (registration_action_id) REFERENCES hq_action(id),
  CONSTRAINT hq_fk_t__pending_action_id FOREIGN KEY (pending_action_id) REFERENCES hq_action(id),
  CONSTRAINT hq_chk_t__native_id_creation CHECK (native_id IS NOT NULL OR state IN ('creating', 'unknown'))
) STRICT;

CREATE INDEX hq_idx_t__workspace_root_created_at_id_desc ON hq_thread (workspace_root, created_at DESC, id DESC);
CREATE INDEX hq_idx_t__runtime_epoch_ownership ON hq_thread (runtime_epoch, ownership);

CREATE TABLE hq_action (
  id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  requested_runtime_epoch TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  control_state TEXT CHECK (control_state IS NULL OR control_state IN ('accepted','applied','held')),
  thread_id TEXT,
  expected_turn_id TEXT,
  native_turn_id TEXT,
  native_request_id TEXT,
  delivery TEXT NOT NULL CHECK (delivery IN ('queued', 'submitted', 'acknowledged', 'uncertain', 'failed', 'canceled')),
  completion TEXT CHECK (completion IS NULL OR completion IN ('completed', 'failed', 'interrupted')),
  failure TEXT CHECK (failure IS NULL OR failure IN ('state-conflict', 'access-denied', 'agent-unavailable', 'operation-failed')),
  related_action_id TEXT,
  queued_input TEXT,
  result TEXT,
  input_sha256 TEXT CHECK (input_sha256 IS NULL OR length(input_sha256) = 64),
  plan_context TEXT,
  collaboration_context TEXT CHECK (collaboration_context IS NULL OR json_valid(collaboration_context)),
  collaboration_collection TEXT CHECK (collaboration_collection IS NULL OR json_valid(collaboration_collection)),
  queue_ready INTEGER NOT NULL DEFAULT 0 CHECK (queue_ready IN (0, 1)),
  requested_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_pk_a__id PRIMARY KEY (id),
  CONSTRAINT hq_fk_a__thread_id FOREIGN KEY (thread_id) REFERENCES hq_thread(id),
  CONSTRAINT hq_fk_a__related_action_id FOREIGN KEY (related_action_id) REFERENCES hq_action(id),
  CONSTRAINT hq_chk_a__queued_input_kind CHECK (queued_input IS NULL OR kind = 'queue'),
  CONSTRAINT hq_chk_a__queued_body_required CHECK (delivery != 'queued' OR (kind = 'queue' AND queued_input IS NOT NULL))
) STRICT;

CREATE INDEX hq_idx_a__provider_created_at_id_desc ON hq_action (provider, created_at DESC, id DESC) WHERE thread_id IS NULL;
CREATE INDEX hq_idx_a__provider_epoch_pending_control ON hq_action (provider, runtime_epoch) WHERE kind IN ('account-login','account-logout','mcp-reload') AND delivery IN ('submitted','uncertain','acknowledged') AND completion IS NULL;
CREATE INDEX hq_idx_a__thread_id_created_at_id_desc ON hq_action (thread_id, created_at DESC, id DESC);
CREATE INDEX hq_idx_a__thread_id_delivery_created_at_id ON hq_action (thread_id, delivery, created_at, id);
CREATE INDEX hq_idx_a__native_turn_id ON hq_action (native_turn_id);
CREATE INDEX hq_idx_a__thread_turn_input ON hq_action (thread_id, native_turn_id, input_sha256) WHERE input_sha256 IS NOT NULL;
CREATE INDEX hq_idx_a__runtime_epoch_delivery ON hq_action (runtime_epoch, delivery);
CREATE INDEX hq_idx_a__runtime_epoch_submitted ON hq_action (runtime_epoch) WHERE delivery = 'submitted';
CREATE INDEX hq_idx_a__requested_name_delivery ON hq_action (requested_name, delivery);
CREATE UNIQUE INDEX hq_uidx_a__runtime_epoch_native_request_id ON hq_action (runtime_epoch, native_request_id) WHERE native_request_id IS NOT NULL;

CREATE TABLE hq_native_approval (
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  native_request_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('command', 'file-change', 'permission', 'question', 'elicitation')),
  is_blocking INTEGER NOT NULL CHECK (is_blocking IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'expired')),
  reply_action_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_pk_na__id PRIMARY KEY (id),
  CONSTRAINT hq_uq_na__runtime_epoch_thread_id_native_request_id UNIQUE (runtime_epoch, thread_id, native_request_id),
  CONSTRAINT hq_fk_na__thread_id FOREIGN KEY (thread_id) REFERENCES hq_thread(id),
  CONSTRAINT hq_fk_na__reply_action_id FOREIGN KEY (reply_action_id) REFERENCES hq_action(id)
) STRICT;

CREATE INDEX hq_idx_na__thread_id_state_created_at_id_desc ON hq_native_approval (thread_id, state, created_at DESC, id DESC);
CREATE INDEX hq_idx_na__thread_id_created_at_id_desc ON hq_native_approval (thread_id, created_at DESC, id DESC);
CREATE INDEX hq_idx_na__runtime_epoch_pending ON hq_native_approval (runtime_epoch) WHERE state = 'pending';

CREATE TABLE hq_event (
  sequence INTEGER CONSTRAINT hq_pk_e__sequence PRIMARY KEY AUTOINCREMENT,
  runtime_epoch TEXT NOT NULL,
  thread_id TEXT,
  action_id TEXT,
  native_turn_id TEXT,
  native_item_id TEXT,
  kind TEXT NOT NULL,
  event_key TEXT,
  digest TEXT,
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_e__runtime_epoch_event_key UNIQUE (runtime_epoch, event_key),
  CONSTRAINT hq_fk_e__thread_id FOREIGN KEY (thread_id) REFERENCES hq_thread(id),
  CONSTRAINT hq_fk_e__action_id FOREIGN KEY (action_id) REFERENCES hq_action(id)
) STRICT;

CREATE INDEX hq_idx_e__thread_id_sequence ON hq_event (thread_id, sequence);

CREATE TABLE hq_plan_operation (
  id TEXT NOT NULL,
  directory TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
  intent TEXT NOT NULL,
  CONSTRAINT hq_pk_po__id PRIMARY KEY (id)
) STRICT;
CREATE UNIQUE INDEX hq_uidx_po__directory_prepared ON hq_plan_operation (directory) WHERE state = 'prepared';

CREATE TABLE hq_plan_milestone (
  directory TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  milestone TEXT NOT NULL,
  CONSTRAINT hq_pk_pm__directory_ordinal PRIMARY KEY (directory, ordinal)
) STRICT;

CREATE TABLE hq_plan_projection (
  directory TEXT NOT NULL,
  source_hash TEXT,
  CONSTRAINT hq_pk_pp__directory PRIMARY KEY (directory)
) STRICT;

CREATE TABLE hq_thread_plan (
 thread_id TEXT NOT NULL,
 directory TEXT NOT NULL,
 context TEXT NOT NULL,
 authorization_id TEXT,
 milestone_id TEXT,
 CONSTRAINT hq_chk_tp__execution_scope_complete CHECK (authorization_id IS NOT NULL OR milestone_id IS NULL),
 CONSTRAINT hq_pk_tp__thread_id PRIMARY KEY (thread_id),
 CONSTRAINT hq_fk_tp__thread_id FOREIGN KEY (thread_id) REFERENCES hq_thread(id)
) STRICT;
CREATE INDEX hq_idx_tp__directory_thread_id ON hq_thread_plan (directory, thread_id);

CREATE UNIQUE INDEX hq_uidx_tp__authorization_id_milestone_id_execution
ON hq_thread_plan (authorization_id, milestone_id) WHERE authorization_id IS NOT NULL AND milestone_id IS NOT NULL;

CREATE UNIQUE INDEX hq_uidx_tp__authorization_id_plan_execution
ON hq_thread_plan (authorization_id) WHERE authorization_id IS NOT NULL AND milestone_id IS NULL;

CREATE TABLE hq_browser_action (
  id TEXT CONSTRAINT hq_pk_ba__id PRIMARY KEY,
  operator_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  native_thread_id TEXT,
  native_input_sha256 TEXT CHECK (native_input_sha256 IS NULL OR length(native_input_sha256) = 64),
  receipt TEXT NOT NULL CHECK (json_valid(receipt))
) STRICT;

CREATE INDEX hq_idx_ba__submitted_epoch ON hq_browser_action (json_extract(receipt, '$.runtimeEpoch'))
WHERE json_extract(receipt, '$.state') = 'submitted';
CREATE UNIQUE INDEX hq_uidx_ba__native_action ON hq_browser_action (json_extract(receipt, '$.nativeActionId'));

CREATE TABLE hq_claude_file (
  workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, identity TEXT NOT NULL,
  file_size INTEGER NOT NULL, byte_offset INTEGER NOT NULL, revision TEXT NOT NULL,
  leaf_id TEXT, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  supported INTEGER NOT NULL, seen TEXT NOT NULL, workspace_state TEXT NOT NULL,
  CONSTRAINT hq_pk_cf__workspace_root_native_id PRIMARY KEY (workspace_root, native_id)
) STRICT;
CREATE INDEX hq_idx_cf__workspace_root_created_at_native_id_desc
ON hq_claude_file(workspace_root, created_at DESC, native_id DESC);
CREATE TABLE hq_claude_entry (
  workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, uuid TEXT NOT NULL,
  parent_uuid TEXT, turn_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL, is_visible INTEGER NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('user-message','agent-message','command','tool','file-change','unsupported')),
  is_current INTEGER NOT NULL, turn_start_offset INTEGER, anchor_id TEXT,
  CONSTRAINT hq_pk_ce__workspace_root_native_id_uuid PRIMARY KEY (workspace_root, native_id, uuid),
  CONSTRAINT hq_fk_ce__workspace_root_native_id FOREIGN KEY (workspace_root, native_id)
  REFERENCES hq_claude_file(workspace_root, native_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX hq_idx_ce__workspace_native_offset_current
ON hq_claude_entry(workspace_root, native_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX hq_idx_ce__workspace_native_turn_offset_current
ON hq_claude_entry(workspace_root, native_id, turn_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX hq_idx_ce__workspace_native_turn_start_current
ON hq_claude_entry(workspace_root, native_id, byte_offset)
WHERE is_current = 1 AND is_visible = 1 AND byte_offset = turn_start_offset;
CREATE INDEX hq_idx_ce__workspace_native_kind_offset_current
ON hq_claude_entry(workspace_root, native_id, item_kind, byte_offset)
WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX hq_idx_ce__workspace_native_turn_kind_offset_current
ON hq_claude_entry(workspace_root, native_id, turn_id, item_kind, byte_offset)
WHERE is_current = 1 AND is_visible = 1;

CREATE TABLE hq_collaboration_task (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_root TEXT NOT NULL,
  owner_operator_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  plan TEXT CHECK (plan IS NULL OR json_valid(plan)),
  policy TEXT NOT NULL CHECK (json_valid(policy)),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  spawn_count INTEGER NOT NULL DEFAULT 0 CHECK (spawn_count >= 0),
  automatic_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (automatic_turn_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','paused','stopped')),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX hq_idx_ct__owner_workspace_sequence
ON hq_collaboration_task(owner_operator_ref, workspace_root, sequence);

CREATE TABLE hq_task_agent (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES hq_collaboration_task(id),
  agent_id TEXT NOT NULL REFERENCES hq_thread(id),
  parent_agent_id TEXT,
  role TEXT,
  permissions TEXT NOT NULL CHECK (json_valid(permissions)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active','paused','stopped')),
  is_revoked INTEGER NOT NULL CHECK (is_revoked IN (0,1)),
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_ta__task_agent UNIQUE(task_id, agent_id),
  CONSTRAINT hq_fk_ta__parent FOREIGN KEY (task_id, parent_agent_id) REFERENCES hq_task_agent(task_id, agent_id),
  CONSTRAINT hq_chk_ta__parent CHECK (parent_agent_id IS NULL OR parent_agent_id != agent_id)
) STRICT;
CREATE INDEX hq_idx_ta__task_sequence ON hq_task_agent(task_id, sequence);
CREATE INDEX hq_idx_ta__agent_task ON hq_task_agent(agent_id, task_id);
CREATE INDEX hq_idx_ta__agent_sequence ON hq_task_agent(agent_id, sequence);
CREATE INDEX hq_idx_ta__parent ON hq_task_agent(task_id, parent_agent_id) WHERE parent_agent_id IS NOT NULL;

CREATE TABLE hq_skill_grant (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES hq_collaboration_task(id),
  issuer_operator_ref TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  eligible_agent_ids TEXT CHECK (eligible_agent_ids IS NULL OR json_valid(eligible_agent_ids)),
  skills TEXT NOT NULL CHECK (json_valid(skills)),
  effects TEXT NOT NULL CHECK (json_valid(effects)),
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  plan TEXT CHECK (plan IS NULL OR json_valid(plan)),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_sg__task_id UNIQUE(task_id, id)
) STRICT;
CREATE INDEX hq_idx_sg__task_sequence ON hq_skill_grant(task_id, sequence);

CREATE TABLE hq_stream (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES hq_collaboration_task(id),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  creator TEXT NOT NULL CHECK (json_valid(creator)),
  is_archived INTEGER NOT NULL CHECK (is_archived IN (0,1)),
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_s__task_id UNIQUE(task_id, id)
) STRICT;
CREATE INDEX hq_idx_s__task_sequence ON hq_stream(task_id, sequence);
CREATE INDEX hq_idx_s__task_archived_sequence ON hq_stream(task_id, is_archived, sequence);

CREATE TABLE hq_subscription (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
  notify INTEGER NOT NULL CHECK (notify IN (0,1)),
  starting_sequence INTEGER NOT NULL CHECK (starting_sequence >= 0),
  read_sequence INTEGER NOT NULL CHECK (read_sequence >= starting_sequence),
  established_by TEXT NOT NULL CHECK (json_valid(established_by)),
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_su__stream_agent UNIQUE(stream_id, agent_id),
  CONSTRAINT hq_fk_su__stream FOREIGN KEY (task_id, stream_id) REFERENCES hq_stream(task_id, id),
  CONSTRAINT hq_fk_su__agent FOREIGN KEY (task_id, agent_id) REFERENCES hq_task_agent(task_id, agent_id)
) STRICT;
CREATE INDEX hq_idx_su__stream_sequence ON hq_subscription(stream_id, sequence) WHERE is_active = 1 AND notify = 1;
CREATE INDEX hq_idx_su__agent_task_stream ON hq_subscription(agent_id, task_id, stream_id) WHERE is_active = 1;
CREATE INDEX hq_idx_su__agent_task_sequence ON hq_subscription(agent_id, task_id, sequence) WHERE is_active = 1;

CREATE TABLE hq_message (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  task_token TEXT GENERATED ALWAYS AS (replace(task_id, '-', '')) STORED,
  stream_id TEXT NOT NULL,
  stream_token TEXT GENERATED ALWAYS AS (replace(stream_id, '-', '')) STORED,
  author TEXT NOT NULL CHECK (json_valid(author)),
  author_agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('information','request','reply','status')),
  body_bytes INTEGER GENERATED ALWAYS AS (length(CAST(body AS BLOB))) STORED,
  reference_count INTEGER GENERATED ALWAYS AS (json_array_length(artifact_references)) STORED,
  summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) <= 1024),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 8192),
  artifact_references TEXT NOT NULL CHECK (json_valid(artifact_references) AND json_array_length(artifact_references) <= 16),
  reply_to_message_id TEXT,
  fanout_after_sequence INTEGER NOT NULL DEFAULT 0,
  fanout_through_sequence INTEGER NOT NULL,
  fanout_complete INTEGER NOT NULL CHECK (fanout_complete IN (0,1)),
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_uq_m__task_id UNIQUE(task_id, id),
  CONSTRAINT hq_uq_m__task_id_sequence UNIQUE(task_id, id, sequence),
  CONSTRAINT hq_fk_m__stream FOREIGN KEY (task_id, stream_id) REFERENCES hq_stream(task_id, id),
  CONSTRAINT hq_fk_m__author FOREIGN KEY (task_id, author_agent_id) REFERENCES hq_task_agent(task_id, agent_id),
  CONSTRAINT hq_fk_m__reply FOREIGN KEY (task_id, reply_to_message_id) REFERENCES hq_message(task_id, id)
) STRICT;
CREATE INDEX hq_idx_m__task_sequence ON hq_message(task_id, sequence);
CREATE INDEX hq_idx_m__stream_sequence ON hq_message(stream_id, sequence);
CREATE INDEX hq_idx_m__task_kind_sequence ON hq_message(task_id, kind, sequence);
CREATE INDEX hq_idx_m__task_author_sequence ON hq_message(task_id, author_agent_id, sequence);
CREATE INDEX hq_idx_m__fanout_sequence ON hq_message(sequence) WHERE fanout_complete = 0;
CREATE INDEX hq_idx_m__task_fanout_sequence ON hq_message(task_id, sequence) WHERE fanout_complete = 0;
CREATE TRIGGER hq_trg_m__immutable BEFORE UPDATE OF sequence, id, task_id, stream_id, author, author_agent_id, kind, summary, body, artifact_references, reply_to_message_id, created_at ON hq_message
BEGIN SELECT RAISE(ABORT, 'HQ message publications are immutable'); END;

CREATE VIRTUAL TABLE hq_message_search USING fts5(task_token, stream_token, summary, body, content='hq_message', content_rowid='sequence');
CREATE TRIGGER hq_trg_m__search_insert AFTER INSERT ON hq_message
BEGIN
  INSERT INTO hq_message_search(rowid, task_token, stream_token, summary, body) VALUES (new.sequence, new.task_token, new.stream_token, new.summary, new.body);
END;
CREATE TRIGGER hq_trg_m__search_delete AFTER DELETE ON hq_message
BEGIN
  INSERT INTO hq_message_search(hq_message_search, rowid, task_token, stream_token, summary, body) VALUES ('delete', old.sequence, old.task_token, old.stream_token, old.summary, old.body);
END;

CREATE TABLE hq_request (
  id TEXT NOT NULL PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  specification TEXT NOT NULL CHECK (json_valid(specification)),
  target_agent_id TEXT,
  assignee_agent_id TEXT,
  is_claimable INTEGER NOT NULL CHECK (is_claimable IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('open','claimed','waiting-children','waiting-input','interrupted','resolved','canceled')),
  current_action_id TEXT REFERENCES hq_action(id),
  parent_request_id TEXT REFERENCES hq_request(id),
  parent_action_id TEXT REFERENCES hq_action(id),
  child_request_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(child_request_ids) AND json_type(child_request_ids) = 'array' AND json_array_length(child_request_ids) <= 32),
  wait_generation INTEGER NOT NULL DEFAULT 0 CHECK (wait_generation >= 0),
  continuation_action_id TEXT,
  clarification_consumed_action_id TEXT REFERENCES hq_action(id),
  pending_action_id TEXT,
  pending_input_message_id TEXT REFERENCES hq_message(id),
  manual_dispatch_id TEXT,
  last_action_id TEXT REFERENCES hq_action(id),
  last_report_id TEXT,
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  required_authority TEXT CHECK (required_authority IS NULL OR required_authority IN ('requester','operator')),
  pause_agent_revision INTEGER,
  dispatch_blocked_reason TEXT,
  failure_reason TEXT,
  grant_id TEXT,
  grant_revision INTEGER,
  skill_name TEXT,
  skill_mode TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','failed')),
  result_references TEXT NOT NULL CHECK (json_valid(result_references) AND json_array_length(result_references) <= 16),
  return_stream_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_fk_r__message FOREIGN KEY (task_id, id, sequence) REFERENCES hq_message(task_id, id, sequence),
  CONSTRAINT hq_fk_r__stream FOREIGN KEY (task_id, stream_id) REFERENCES hq_stream(task_id, id),
  CONSTRAINT hq_fk_r__return FOREIGN KEY (task_id, return_stream_id) REFERENCES hq_stream(task_id, id),
  CONSTRAINT hq_fk_r__target FOREIGN KEY (task_id, target_agent_id) REFERENCES hq_task_agent(task_id, agent_id),
  CONSTRAINT hq_fk_r__assignee FOREIGN KEY (task_id, assignee_agent_id) REFERENCES hq_task_agent(task_id, agent_id),
  CONSTRAINT hq_fk_r__grant FOREIGN KEY (task_id, grant_id) REFERENCES hq_skill_grant(task_id, id),
  CONSTRAINT hq_chk_r__assignment CHECK ((target_agent_id IS NOT NULL AND is_claimable = 0) OR (target_agent_id IS NULL AND is_claimable = 1)),
  CONSTRAINT hq_chk_r__grant CHECK ((grant_id IS NULL AND grant_revision IS NULL) OR (grant_id IS NOT NULL AND grant_revision > 0)),
  CONSTRAINT hq_chk_r__resolution CHECK ((state = 'resolved' AND outcome IS NOT NULL) OR (state != 'resolved' AND outcome IS NULL))
) STRICT;
CREATE INDEX hq_idx_r__task_sequence ON hq_request(task_id, sequence);
CREATE INDEX hq_idx_r__task_state ON hq_request(task_id, state, sequence);
CREATE INDEX hq_idx_r__stream_sequence ON hq_request(task_id, stream_id, sequence);
CREATE INDEX hq_idx_r__assignee_state ON hq_request(task_id, assignee_agent_id, state, sequence);
CREATE INDEX hq_idx_r__target_state ON hq_request(task_id, target_agent_id, state, sequence);
CREATE INDEX hq_idx_r__assignee_sequence ON hq_request(task_id, assignee_agent_id, sequence);
CREATE INDEX hq_idx_r__target_sequence ON hq_request(task_id, target_agent_id, sequence);
CREATE UNIQUE INDEX hq_uidx_r__assignee_active ON hq_request(assignee_agent_id) WHERE current_action_id IS NOT NULL;
CREATE INDEX hq_idx_r__dispatch_sequence ON hq_request(sequence) WHERE current_action_id IS NOT NULL OR pending_action_id IS NOT NULL;
CREATE INDEX hq_idx_r__task_active ON hq_request(task_id, sequence) WHERE current_action_id IS NOT NULL;
CREATE INDEX hq_idx_r__parent_state ON hq_request(parent_request_id, state);
CREATE INDEX hq_idx_r__waiting_sequence ON hq_request(sequence) WHERE state = 'waiting-children';
CREATE INDEX hq_idx_r__assignee_waiting ON hq_request(assignee_agent_id, sequence) WHERE state = 'waiting-children';
CREATE TRIGGER hq_trg_r__parent_immutable BEFORE UPDATE OF parent_request_id, parent_action_id ON hq_request
WHEN new.parent_request_id IS NOT old.parent_request_id OR new.parent_action_id IS NOT old.parent_action_id
BEGIN SELECT RAISE(ABORT, 'HQ request parent links are immutable'); END;

CREATE TABLE hq_report (
  id TEXT NOT NULL PRIMARY KEY,
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE REFERENCES hq_action(id),
  reply_message_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL UNIQUE,
  stream_id TEXT NOT NULL,
  task_token TEXT GENERATED ALWAYS AS (replace(task_id, '-', '')) STORED,
  stream_token TEXT GENERATED ALWAYS AS (replace(stream_id, '-', '')) STORED,
  author_agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','waiting-children','needs-input','paused','failed')),
  payload BLOB NOT NULL CHECK (length(payload) <= 1048576),
  byte_count INTEGER GENERATED ALWAYS AS (length(payload)) STORED,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_fk_re__request FOREIGN KEY (task_id, request_id) REFERENCES hq_message(task_id, id),
  CONSTRAINT hq_fk_re__reply FOREIGN KEY (task_id, reply_message_id, sequence) REFERENCES hq_message(task_id, id, sequence),
  CONSTRAINT hq_fk_re__author FOREIGN KEY (task_id, author_agent_id) REFERENCES hq_task_agent(task_id, agent_id)
) STRICT;
CREATE INDEX hq_idx_re__task_sequence ON hq_report(task_id, sequence);
CREATE TRIGGER hq_trg_re__immutable BEFORE UPDATE ON hq_report
BEGIN SELECT RAISE(ABORT, 'HQ reports are immutable'); END;
CREATE VIRTUAL TABLE hq_report_search USING fts5(task_token, stream_token, payload, content='hq_report', content_rowid='sequence');
CREATE TRIGGER hq_trg_re__search_insert AFTER INSERT ON hq_report
BEGIN
  INSERT INTO hq_report_search(rowid, task_token, stream_token, payload) VALUES (new.sequence, new.task_token, new.stream_token, CAST(new.payload AS TEXT));
END;
CREATE TRIGGER hq_trg_re__search_delete AFTER DELETE ON hq_report
BEGIN
  INSERT INTO hq_report_search(hq_report_search, rowid, task_token, stream_token, payload) VALUES ('delete', old.sequence, old.task_token, old.stream_token, CAST(old.payload AS TEXT));
END;

CREATE TABLE hq_delivery (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_sequence INTEGER NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  native_action_id TEXT REFERENCES hq_action(id),
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  CONSTRAINT hq_uq_d__message_agent UNIQUE(message_id, recipient_agent_id),
  CONSTRAINT hq_fk_d__message FOREIGN KEY (task_id, message_id, message_sequence) REFERENCES hq_message(task_id, id, sequence),
  CONSTRAINT hq_fk_d__recipient FOREIGN KEY (task_id, recipient_agent_id) REFERENCES hq_task_agent(task_id, agent_id)
) STRICT;
CREATE INDEX hq_idx_d__task_sequence ON hq_delivery(task_id, sequence);
CREATE INDEX hq_idx_d__agent_task_sequence ON hq_delivery(recipient_agent_id, task_id, sequence);
CREATE INDEX hq_idx_d__agent_pending_sequence ON hq_delivery(recipient_agent_id, task_id, sequence) WHERE delivered_at IS NULL;
CREATE INDEX hq_idx_d__task_pending_sequence ON hq_delivery(task_id, sequence) WHERE delivered_at IS NULL;
CREATE INDEX hq_idx_d__agent_unack_sequence ON hq_delivery(recipient_agent_id, task_id, sequence) WHERE acknowledged_at IS NULL;
CREATE INDEX hq_idx_d__task_unack_sequence ON hq_delivery(task_id, sequence) WHERE acknowledged_at IS NULL;

CREATE TABLE hq_collaboration_operation (
  id TEXT NOT NULL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES hq_collaboration_task(id),
  actor TEXT NOT NULL CHECK (json_valid(actor)),
  command_kind TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX hq_idx_co__task_created_id ON hq_collaboration_operation(task_id, created_at, id);

CREATE TABLE hq_agent_spawn (
  action_id TEXT NOT NULL PRIMARY KEY REFERENCES hq_action(id),
  task_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  child_agent_id TEXT UNIQUE,
  purpose TEXT NOT NULL CHECK (length(CAST(purpose AS BLOB)) <= 1024),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  created_at INTEGER NOT NULL,
  CONSTRAINT hq_fk_as__parent FOREIGN KEY (task_id, parent_agent_id) REFERENCES hq_task_agent(task_id, agent_id),
  CONSTRAINT hq_fk_as__child FOREIGN KEY (task_id, child_agent_id) REFERENCES hq_task_agent(task_id, agent_id)
) STRICT;

-- durable plan references support seek enumeration without repeated JSON scans
CREATE TABLE hq_plan_registration (
  directory TEXT NOT NULL CONSTRAINT hq_pk_preg__directory PRIMARY KEY
) STRICT;
CREATE TRIGGER hq_trg_po__register AFTER INSERT ON hq_plan_operation
BEGIN INSERT INTO hq_plan_registration VALUES (new.directory) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_pp__register AFTER INSERT ON hq_plan_projection
BEGIN INSERT INTO hq_plan_registration VALUES (new.directory) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_tp__register AFTER INSERT ON hq_thread_plan
BEGIN INSERT INTO hq_plan_registration VALUES (new.directory) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_tp__register_update AFTER UPDATE OF directory ON hq_thread_plan
BEGIN INSERT INTO hq_plan_registration VALUES (new.directory) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_ct__register AFTER INSERT ON hq_collaboration_task WHEN new.plan IS NOT NULL
BEGIN INSERT INTO hq_plan_registration VALUES (json_extract(new.plan, '$.directory')) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_ct__register_update AFTER UPDATE OF plan ON hq_collaboration_task WHEN new.plan IS NOT NULL
BEGIN INSERT INTO hq_plan_registration VALUES (json_extract(new.plan, '$.directory')) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_sg__register AFTER INSERT ON hq_skill_grant WHEN new.plan IS NOT NULL
BEGIN INSERT INTO hq_plan_registration VALUES (json_extract(new.plan, '$.directory')) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_r__register AFTER INSERT ON hq_request WHEN json_extract(new.specification, '$.plan') IS NOT NULL
BEGIN INSERT INTO hq_plan_registration VALUES (json_extract(new.specification, '$.plan.directory')) ON CONFLICT(directory) DO NOTHING; END;
CREATE TRIGGER hq_trg_r__register_update AFTER UPDATE OF specification ON hq_request WHEN json_extract(new.specification, '$.plan') IS NOT NULL
BEGIN INSERT INTO hq_plan_registration VALUES (json_extract(new.specification, '$.plan.directory')) ON CONFLICT(directory) DO NOTHING; END;

-- sessions another client drives, with the live state HQ last observed
CREATE TABLE hq_observed_session (
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  native_id TEXT NOT NULL CHECK (length(native_id) > 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  observed_at INTEGER NOT NULL,
  CONSTRAINT hq_pk_os__provider_native_id PRIMARY KEY (provider, native_id)
) STRICT;

-- ordered state changes of managed and observed sessions, kept for seven days
CREATE TABLE hq_session_transition (
  sequence INTEGER CONSTRAINT hq_pk_st__sequence PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  native_id TEXT,
  thread_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('external', 'managed', 'uncertain')),
  previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  reason TEXT NOT NULL CHECK (reason IN ('opened', 'turn-started', 'turn-completed', 'waiting-for-input', 'operator-stopped', 'failed', 'disappeared', 'closed')),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX hq_idx_st__recorded_at ON hq_session_transition (recorded_at);
CREATE INDEX hq_idx_st__thread_id_sequence ON hq_session_transition (thread_id, sequence) WHERE thread_id IS NOT NULL;
CREATE TRIGGER hq_trg_st__prune AFTER INSERT ON hq_session_transition
BEGIN DELETE FROM hq_session_transition WHERE sequence IN (SELECT sequence FROM hq_session_transition WHERE recorded_at < new.recorded_at - 604800000 ORDER BY recorded_at LIMIT 128); END;

-- the session state each managed thread state reports; stopping keeps the state it stops
CREATE TABLE hq_session_state_map (
  thread_state TEXT NOT NULL CONSTRAINT hq_pk_ssm__thread_state PRIMARY KEY,
  session_state TEXT
) STRICT;
INSERT INTO hq_session_state_map (thread_state, session_state) VALUES
  ('creating', 'unknown'), ('inactive', 'closed'), ('idle', 'idle'), ('starting', 'running'),
  ('running', 'running'), ('waiting-input', 'waiting'), ('waiting-approval', 'waiting'),
  ('stopping', NULL), ('completed', 'idle'), ('failed', 'failed'), ('interrupted', 'idle'),
  ('unknown', 'unknown');

/*
 * A managed session's previous state is its last recorded transition. It stops only through an
 * operator interrupt or close, so leaving a running or waiting state for idle-after-interrupt or
 * closed is an operator stop; unknown means ownership or the native connection was lost.
 */
CREATE TRIGGER hq_trg_t__transition AFTER UPDATE OF state ON hq_thread
WHEN old.state != new.state AND (SELECT session_state FROM hq_session_state_map WHERE thread_state = new.state) IS NOT NULL
BEGIN
  INSERT INTO hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
  SELECT new.provider, new.native_id, new.id, new.ownership, previous.state, next.session_state,
    CASE
      WHEN next.session_state = 'running' THEN 'turn-started'
      WHEN next.session_state = 'waiting' THEN 'waiting-for-input'
      WHEN next.session_state = 'idle' AND previous.state IN ('running', 'waiting') AND new.state = 'interrupted' THEN 'operator-stopped'
      WHEN next.session_state = 'idle' AND previous.state IN ('running', 'waiting') THEN 'turn-completed'
      WHEN next.session_state = 'idle' THEN 'opened'
      WHEN next.session_state = 'closed' AND previous.state IN ('running', 'waiting') THEN 'operator-stopped'
      WHEN next.session_state = 'closed' THEN 'closed'
      WHEN next.session_state = 'failed' THEN 'failed'
      ELSE 'disappeared'
    END,
    new.updated_at
  FROM hq_session_state_map AS next
  LEFT JOIN (SELECT state FROM hq_session_transition WHERE thread_id = new.id ORDER BY sequence DESC LIMIT 1) AS previous ON 1
  WHERE next.thread_state = new.state AND next.session_state IS NOT previous.state;
END;

-- an observed session that leaves while it runs or waits disappeared; leaving while idle closed it
CREATE TRIGGER hq_trg_os__insert AFTER INSERT ON hq_observed_session
BEGIN
  INSERT INTO hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
  VALUES (new.provider, new.native_id, NULL, 'external', NULL, new.state,
    CASE new.state WHEN 'running' THEN 'turn-started' WHEN 'waiting' THEN 'waiting-for-input' WHEN 'idle' THEN 'opened' WHEN 'failed' THEN 'failed' WHEN 'closed' THEN 'closed' ELSE 'disappeared' END,
    new.observed_at);
END;
CREATE TRIGGER hq_trg_os__state AFTER UPDATE OF state ON hq_observed_session WHEN old.state != new.state
BEGIN
  INSERT INTO hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
  VALUES (new.provider, new.native_id, NULL, 'external', old.state, new.state,
    CASE
      WHEN new.state = 'running' THEN 'turn-started'
      WHEN new.state = 'waiting' THEN 'waiting-for-input'
      WHEN new.state = 'idle' AND old.state IN ('running', 'waiting') THEN 'turn-completed'
      WHEN new.state = 'idle' THEN 'opened'
      WHEN new.state = 'closed' AND old.state IN ('running', 'waiting') THEN 'disappeared'
      WHEN new.state = 'closed' THEN 'closed'
      WHEN new.state = 'failed' THEN 'failed'
      ELSE 'disappeared'
    END,
    new.observed_at);
END;
