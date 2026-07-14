-- Tombstones for the audited memory deletion lifecycle (#51).
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_client_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_deletion_reason_length
    CHECK (deletion_reason IS NULL OR char_length(deletion_reason) <= 512);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Ordinary reads overwhelmingly address active rows; purge scans old tombstones
-- in stable retention order.
CREATE INDEX IF NOT EXISTS memories_active_namespace_created_idx
  ON memories (namespace, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memories_deleted_purge_idx
  ON memories (deleted_at, id) WHERE deleted_at IS NOT NULL;
