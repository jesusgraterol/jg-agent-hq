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
