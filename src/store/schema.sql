CREATE TABLE agent_hq_schema (
  id INTEGER NOT NULL CONSTRAINT agent_hq_pk_schema__id PRIMARY KEY CHECK (id = 1),
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64),
  action_key_hash TEXT NOT NULL CHECK (length(action_key_hash) = 64),
  package_version TEXT NOT NULL CHECK (length(package_version) BETWEEN 1 AND 64)
) STRICT;

CREATE TABLE agent_hq_thread (
  id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  native_id TEXT CHECK (native_id IS NULL OR length(native_id) > 0),
  native_lineage TEXT CHECK (native_lineage IS NULL OR json_valid(native_lineage)),
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
  CONSTRAINT agent_hq_pk_t__id PRIMARY KEY (id),
  CONSTRAINT agent_hq_uq_t__provider_native_id UNIQUE (provider, native_id),
  CONSTRAINT agent_hq_uq_t__name UNIQUE (name),
  CONSTRAINT agent_hq_uq_t__pending_action_id UNIQUE (pending_action_id),
  CONSTRAINT agent_hq_fk_t__registration_action_id FOREIGN KEY (registration_action_id) REFERENCES agent_hq_action(id),
  CONSTRAINT agent_hq_fk_t__pending_action_id FOREIGN KEY (pending_action_id) REFERENCES agent_hq_action(id),
  CONSTRAINT agent_hq_chk_t__native_id_creation CHECK (native_id IS NOT NULL OR state IN ('creating', 'unknown'))
) STRICT;

CREATE INDEX agent_hq_idx_t__workspace_root_created_at_id_desc ON agent_hq_thread (workspace_root, created_at DESC, id DESC);
CREATE INDEX agent_hq_idx_t__runtime_epoch_ownership ON agent_hq_thread (runtime_epoch, ownership);

CREATE TABLE agent_hq_action (
  id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  requested_runtime_epoch TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  thread_id TEXT,
  expected_turn_id TEXT,
  native_turn_id TEXT,
  -- the native step the action takes now; a create continues with name, a clean with close
  phase TEXT CHECK (phase IS NULL OR phase IN ('create', 'resume', 'name', 'turn', 'steer', 'interrupt', 'clean', 'close', 'reply')),
  delivery TEXT NOT NULL CHECK (delivery IN ('queued', 'submitted', 'acknowledged', 'uncertain', 'failed', 'canceled')),
  completion TEXT CHECK (completion IS NULL OR completion IN ('completed', 'failed', 'interrupted')),
  failure TEXT CHECK (failure IS NULL OR failure IN ('state-conflict', 'access-denied', 'agent-unavailable', 'operation-failed')),
  related_action_id TEXT,
  queued_input TEXT,
  result TEXT,
  input_sha256 TEXT CHECK (input_sha256 IS NULL OR length(input_sha256) = 64),
  queue_ready INTEGER NOT NULL DEFAULT 0 CHECK (queue_ready IN (0, 1)),
  requested_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT agent_hq_pk_a__id PRIMARY KEY (id),
  CONSTRAINT agent_hq_fk_a__thread_id FOREIGN KEY (thread_id) REFERENCES agent_hq_thread(id),
  CONSTRAINT agent_hq_fk_a__related_action_id FOREIGN KEY (related_action_id) REFERENCES agent_hq_action(id),
  CONSTRAINT agent_hq_chk_a__queued_input_kind CHECK (queued_input IS NULL OR kind = 'queue'),
  CONSTRAINT agent_hq_chk_a__queued_body_required CHECK (delivery != 'queued' OR (kind = 'queue' AND queued_input IS NOT NULL))
) STRICT;

CREATE INDEX agent_hq_idx_a__thread_id_created_at_id_desc ON agent_hq_action (thread_id, created_at DESC, id DESC);
CREATE INDEX agent_hq_idx_a__thread_id_delivery_created_at_id ON agent_hq_action (thread_id, delivery, created_at, id);
CREATE INDEX agent_hq_idx_a__native_turn_id ON agent_hq_action (native_turn_id);
CREATE INDEX agent_hq_idx_a__thread_turn_input ON agent_hq_action (thread_id, native_turn_id, input_sha256) WHERE input_sha256 IS NOT NULL;
CREATE INDEX agent_hq_idx_a__runtime_epoch_delivery ON agent_hq_action (runtime_epoch, delivery);
CREATE INDEX agent_hq_idx_a__runtime_epoch_submitted ON agent_hq_action (runtime_epoch) WHERE delivery = 'submitted';
CREATE INDEX agent_hq_idx_a__requested_name_delivery ON agent_hq_action (requested_name, delivery);

CREATE TABLE agent_hq_native_approval (
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
  CONSTRAINT agent_hq_pk_na__id PRIMARY KEY (id),
  CONSTRAINT agent_hq_uq_na__runtime_epoch_thread_id_native_request_id UNIQUE (runtime_epoch, thread_id, native_request_id),
  CONSTRAINT agent_hq_fk_na__thread_id FOREIGN KEY (thread_id) REFERENCES agent_hq_thread(id),
  CONSTRAINT agent_hq_fk_na__reply_action_id FOREIGN KEY (reply_action_id) REFERENCES agent_hq_action(id)
) STRICT;

CREATE INDEX agent_hq_idx_na__thread_id_state_created_at_id_desc ON agent_hq_native_approval (thread_id, state, created_at DESC, id DESC);
CREATE INDEX agent_hq_idx_na__thread_id_created_at_id_desc ON agent_hq_native_approval (thread_id, created_at DESC, id DESC);
CREATE INDEX agent_hq_idx_na__runtime_epoch_pending ON agent_hq_native_approval (runtime_epoch) WHERE state = 'pending';

-- each native observation a runtime applied, by its identity, so a repeated one is recognized
CREATE TABLE agent_hq_event (
  sequence INTEGER CONSTRAINT agent_hq_pk_e__sequence PRIMARY KEY AUTOINCREMENT,
  runtime_epoch TEXT NOT NULL,
  event_key TEXT NOT NULL CHECK (length(event_key) = 64),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  CONSTRAINT agent_hq_uq_e__runtime_epoch_event_key UNIQUE (runtime_epoch, event_key)
) STRICT;

-- host-admitted browser effects; a receipt's native action is the one action its dispatch may submit
CREATE TABLE agent_hq_browser_action (
  id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  runtime_epoch TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'acknowledged', 'uncertain')),
  native_action_id TEXT NOT NULL,
  native_thread_id TEXT,
  native_input_sha256 TEXT CHECK (native_input_sha256 IS NULL OR length(native_input_sha256) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT agent_hq_pk_ba__id PRIMARY KEY (id),
  CONSTRAINT agent_hq_uq_ba__native_action_id UNIQUE (native_action_id)
) STRICT;

CREATE INDEX agent_hq_idx_ba__runtime_epoch_submitted ON agent_hq_browser_action (runtime_epoch) WHERE state = 'submitted';

-- a transcript's index; modified_at is its modification time once the index reached its end, else null
CREATE TABLE agent_hq_claude_file (
  workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, identity TEXT NOT NULL,
  file_size INTEGER NOT NULL, modified_at REAL, byte_offset INTEGER NOT NULL, revision TEXT NOT NULL,
  leaf_id TEXT, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  supported INTEGER NOT NULL, workspace_state TEXT NOT NULL,
  CONSTRAINT agent_hq_pk_cf__workspace_root_native_id PRIMARY KEY (workspace_root, native_id)
) STRICT;
-- the thread list's last-activity order, and an observed session's lookup by native ID alone
CREATE INDEX agent_hq_idx_cf__workspace_root_updated_at_native_id_desc
ON agent_hq_claude_file(workspace_root, updated_at DESC, native_id DESC);
CREATE INDEX agent_hq_idx_cf__native_id_updated_at_desc ON agent_hq_claude_file(native_id, updated_at DESC);
CREATE TABLE agent_hq_claude_entry (
  workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, uuid TEXT NOT NULL,
  parent_uuid TEXT, turn_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL, is_visible INTEGER NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('user-message','agent-message','command','tool','file-change','notice','unsupported')),
  is_current INTEGER NOT NULL, turn_start_offset INTEGER, anchor_id TEXT,
  CONSTRAINT agent_hq_pk_ce__workspace_root_native_id_uuid PRIMARY KEY (workspace_root, native_id, uuid),
  CONSTRAINT agent_hq_fk_ce__workspace_root_native_id FOREIGN KEY (workspace_root, native_id)
  REFERENCES agent_hq_claude_file(workspace_root, native_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX agent_hq_idx_ce__workspace_native_offset_current
ON agent_hq_claude_entry(workspace_root, native_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX agent_hq_idx_ce__workspace_native_turn_offset_current
ON agent_hq_claude_entry(workspace_root, native_id, turn_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX agent_hq_idx_ce__workspace_native_kind_offset_current
ON agent_hq_claude_entry(workspace_root, native_id, item_kind, byte_offset)
WHERE is_current = 1 AND is_visible = 1;
CREATE INDEX agent_hq_idx_ce__workspace_native_turn_kind_offset_current
ON agent_hq_claude_entry(workspace_root, native_id, turn_id, item_kind, byte_offset)
WHERE is_current = 1 AND is_visible = 1;

-- sessions another client drives, with the live state HQ last observed
CREATE TABLE agent_hq_observed_session (
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  native_id TEXT NOT NULL CHECK (length(native_id) > 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  observed_at INTEGER NOT NULL,
  CONSTRAINT agent_hq_pk_os__provider_native_id PRIMARY KEY (provider, native_id)
) STRICT;

-- ordered state changes of managed and observed sessions, kept for seven days
CREATE TABLE agent_hq_session_transition (
  sequence INTEGER CONSTRAINT agent_hq_pk_st__sequence PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  native_id TEXT,
  thread_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('external', 'managed', 'uncertain')),
  previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'idle', 'closed', 'failed', 'unknown')),
  reason TEXT NOT NULL CHECK (reason IN ('opened', 'turn-started', 'turn-completed', 'waiting-for-input', 'operator-stopped', 'failed', 'disappeared', 'closed')),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_hq_idx_st__recorded_at ON agent_hq_session_transition (recorded_at);
CREATE INDEX agent_hq_idx_st__thread_id_sequence ON agent_hq_session_transition (thread_id, sequence) WHERE thread_id IS NOT NULL;
CREATE TRIGGER agent_hq_trg_st__prune AFTER INSERT ON agent_hq_session_transition
BEGIN DELETE FROM agent_hq_session_transition WHERE sequence IN (SELECT sequence FROM agent_hq_session_transition WHERE recorded_at < new.recorded_at - 604800000 ORDER BY recorded_at LIMIT 128); END;

-- the session state each managed thread state reports; stopping keeps the state it stops
CREATE TABLE agent_hq_session_state_map (
  thread_state TEXT NOT NULL CONSTRAINT agent_hq_pk_ssm__thread_state PRIMARY KEY,
  session_state TEXT
) STRICT;
INSERT INTO agent_hq_session_state_map (thread_state, session_state) VALUES
  ('creating', 'unknown'), ('inactive', 'closed'), ('idle', 'idle'), ('starting', 'running'),
  ('running', 'running'), ('waiting-input', 'waiting'), ('waiting-approval', 'waiting'),
  ('stopping', NULL), ('completed', 'idle'), ('failed', 'failed'), ('interrupted', 'idle'),
  ('unknown', 'unknown');

/*
 * A managed session's previous state is its last recorded transition. It stops only through an
 * operator interrupt or close, so leaving a running or waiting state for idle-after-interrupt or
 * closed is an operator stop; unknown means ownership or the native connection was lost.
 */
CREATE TRIGGER agent_hq_trg_t__transition AFTER UPDATE OF state ON agent_hq_thread
WHEN old.state != new.state AND (SELECT session_state FROM agent_hq_session_state_map WHERE thread_state = new.state) IS NOT NULL
BEGIN
  INSERT INTO agent_hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
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
  FROM agent_hq_session_state_map AS next
  LEFT JOIN (SELECT state FROM agent_hq_session_transition WHERE thread_id = new.id ORDER BY sequence DESC LIMIT 1) AS previous ON 1
  WHERE next.thread_state = new.state AND next.session_state IS NOT previous.state;
END;

-- an observed session that leaves while it runs or waits disappeared; leaving while idle closed it
CREATE TRIGGER agent_hq_trg_os__insert AFTER INSERT ON agent_hq_observed_session
BEGIN
  INSERT INTO agent_hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
  VALUES (new.provider, new.native_id, NULL, 'external', NULL, new.state,
    CASE new.state WHEN 'running' THEN 'turn-started' WHEN 'waiting' THEN 'waiting-for-input' WHEN 'idle' THEN 'opened' WHEN 'failed' THEN 'failed' WHEN 'closed' THEN 'closed' ELSE 'disappeared' END,
    new.observed_at);
END;
CREATE TRIGGER agent_hq_trg_os__state AFTER UPDATE OF state ON agent_hq_observed_session WHEN old.state != new.state
BEGIN
  INSERT INTO agent_hq_session_transition (provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at)
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
