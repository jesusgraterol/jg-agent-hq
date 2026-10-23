CREATE TABLE hq_schema (
  id INTEGER NOT NULL CONSTRAINT hq_pk_schema__id PRIMARY KEY CHECK (id = 1),
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64)
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
  plan_context TEXT,
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

CREATE INDEX hq_idx_a__thread_id_created_at_id_desc ON hq_action (thread_id, created_at DESC, id DESC);
CREATE INDEX hq_idx_a__thread_id_delivery_created_at_id ON hq_action (thread_id, delivery, created_at, id);
CREATE INDEX hq_idx_a__native_turn_id ON hq_action (native_turn_id);
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
  kind TEXT NOT NULL CHECK (kind IN ('command', 'file-change', 'permission', 'question')),
  is_blocking INTEGER NOT NULL CHECK (is_blocking IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'expired')),
  reply_action_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT hq_pk_na__id PRIMARY KEY (id),
  CONSTRAINT hq_uq_na__runtime_epoch_native_request_id UNIQUE (runtime_epoch, native_request_id),
  CONSTRAINT hq_fk_na__thread_id FOREIGN KEY (thread_id) REFERENCES hq_thread(id),
  CONSTRAINT hq_fk_na__reply_action_id FOREIGN KEY (reply_action_id) REFERENCES hq_action(id)
) STRICT;

CREATE INDEX hq_idx_na__thread_id_state ON hq_native_approval (thread_id, state);
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

CREATE TABLE hq_plan_revision_projection (
 directory TEXT NOT NULL,
 source_hash TEXT,
 CONSTRAINT hq_pk_prp__directory PRIMARY KEY (directory)
) STRICT;
CREATE TABLE hq_plan_record (
 directory TEXT NOT NULL,
 collection TEXT NOT NULL,
 record_id TEXT NOT NULL,
 entry TEXT NOT NULL,
 CONSTRAINT hq_pk_pr__directory_collection_record_id PRIMARY KEY (directory, collection, record_id)
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

CREATE TABLE hq_handoff (
 id TEXT NOT NULL,
 workspace_root TEXT NOT NULL,
 source_thread_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 intent TEXT NOT NULL,
 CONSTRAINT hq_pk_h__id PRIMARY KEY (id),
 CONSTRAINT hq_fk_h__source_thread_id FOREIGN KEY (source_thread_id) REFERENCES hq_thread(id)
) STRICT;
CREATE INDEX hq_idx_h__workspace_root_created_at_id_desc ON hq_handoff (workspace_root, created_at DESC, id DESC);
CREATE INDEX hq_idx_h__workspace_root_source_thread_id_created_at_id_desc ON hq_handoff (workspace_root, source_thread_id, created_at DESC, id DESC);
CREATE TABLE hq_handoff_dispatch (
 handoff_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK (phase IN ('review', 'feedback')),
 action_id TEXT NOT NULL,
 intent TEXT NOT NULL,
 CONSTRAINT hq_pk_hd__handoff_id_phase PRIMARY KEY (handoff_id, phase),
 CONSTRAINT hq_uq_hd__action_id UNIQUE (action_id),
 CONSTRAINT hq_fk_hd__handoff_id FOREIGN KEY (handoff_id) REFERENCES hq_handoff(id)
) STRICT;

CREATE TABLE hq_browser_action (
  id TEXT CONSTRAINT hq_pk_ba__id PRIMARY KEY,
  operator_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  receipt TEXT NOT NULL CHECK (json_valid(receipt))
) STRICT;

CREATE INDEX hq_idx_ba__submitted_epoch ON hq_browser_action (json_extract(receipt, '$.runtimeEpoch'))
WHERE json_extract(receipt, '$.state') = 'submitted';

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
