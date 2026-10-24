ALTER TABLE hq_schema ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version > 0);
