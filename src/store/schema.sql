CREATE TABLE IF NOT EXISTS native_history_index (
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
  CONSTRAINT pk_nhi__provider_native_id PRIMARY KEY (provider, native_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_nhi__provider_workspace_root_created_at_native_id
ON native_history_index (provider, workspace_root, created_at DESC, native_id DESC);

CREATE TABLE IF NOT EXISTS thread (
  id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  native_id TEXT CHECK (native_id IS NULL OR length(native_id) > 0),
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
  CONSTRAINT pk_t__id PRIMARY KEY (id),
  CONSTRAINT uq_t__provider_native_id UNIQUE (provider, native_id),
  CONSTRAINT uq_t__name UNIQUE (name),
  CONSTRAINT uq_t__pending_action_id UNIQUE (pending_action_id),
  CONSTRAINT fk_t__registration_action_id FOREIGN KEY (registration_action_id) REFERENCES action(id),
  CONSTRAINT fk_t__pending_action_id FOREIGN KEY (pending_action_id) REFERENCES action(id),
  CONSTRAINT chk_t__native_id_creation CHECK (native_id IS NOT NULL OR state IN ('creating', 'unknown'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_t__workspace_root_created_at_id_desc ON thread (workspace_root, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_t__runtime_epoch_ownership ON thread (runtime_epoch, ownership);

CREATE TABLE IF NOT EXISTS action (
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
  queued_text TEXT,
  queue_ready INTEGER NOT NULL DEFAULT 0 CHECK (queue_ready IN (0, 1)),
  requested_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pk_a__id PRIMARY KEY (id),
  CONSTRAINT fk_a__thread_id FOREIGN KEY (thread_id) REFERENCES thread(id),
  CONSTRAINT fk_a__related_action_id FOREIGN KEY (related_action_id) REFERENCES action(id),
  CONSTRAINT chk_a__queued_text_kind CHECK (queued_text IS NULL OR kind = 'queue'),
  CONSTRAINT chk_a__queued_body_required CHECK (delivery != 'queued' OR (kind = 'queue' AND queued_text IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_a__thread_id_created_at_id_desc ON action (thread_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_a__thread_id_delivery_created_at_id ON action (thread_id, delivery, created_at, id);
CREATE INDEX IF NOT EXISTS idx_a__native_turn_id ON action (native_turn_id);
CREATE INDEX IF NOT EXISTS idx_a__runtime_epoch_delivery ON action (runtime_epoch, delivery);
CREATE INDEX IF NOT EXISTS idx_a__runtime_epoch_submitted ON action (runtime_epoch) WHERE delivery = 'submitted';
CREATE INDEX IF NOT EXISTS idx_a__requested_name_delivery ON action (requested_name, delivery);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_a__runtime_epoch_native_request_id ON action (runtime_epoch, native_request_id) WHERE native_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS native_approval (
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
  CONSTRAINT pk_na__id PRIMARY KEY (id),
  CONSTRAINT uq_na__runtime_epoch_native_request_id UNIQUE (runtime_epoch, native_request_id),
  CONSTRAINT fk_na__thread_id FOREIGN KEY (thread_id) REFERENCES thread(id),
  CONSTRAINT fk_na__reply_action_id FOREIGN KEY (reply_action_id) REFERENCES action(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_na__thread_id_state ON native_approval (thread_id, state);
CREATE INDEX IF NOT EXISTS idx_na__runtime_epoch_pending ON native_approval (runtime_epoch) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS event (
  sequence INTEGER CONSTRAINT pk_e__sequence PRIMARY KEY AUTOINCREMENT,
  runtime_epoch TEXT NOT NULL,
  thread_id TEXT,
  action_id TEXT,
  native_turn_id TEXT,
  native_item_id TEXT,
  kind TEXT NOT NULL,
  event_key TEXT,
  digest TEXT,
  created_at INTEGER NOT NULL,
  CONSTRAINT uq_e__runtime_epoch_event_key UNIQUE (runtime_epoch, event_key),
  CONSTRAINT fk_e__thread_id FOREIGN KEY (thread_id) REFERENCES thread(id),
  CONSTRAINT fk_e__action_id FOREIGN KEY (action_id) REFERENCES action(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_e__thread_id_sequence ON event (thread_id, sequence);
