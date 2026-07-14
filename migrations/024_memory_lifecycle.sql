-- Tombstones for the audited memory deletion lifecycle (#51).
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_client_id UUID,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- Add constraints without scanning memories while this transaction still holds
-- the preceding ALTER TABLE lock. The separate online finalizer validates each
-- constraint in its own autocommit operation after this migration commits.
DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_deleted_by_client_id_fkey
    FOREIGN KEY (deleted_by_client_id)
    REFERENCES public.api_keys(id)
    ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_deletion_reason_length
    CHECK (deletion_reason IS NULL OR char_length(deletion_reason) <= 512)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Constraint validation and the active-read/purge indexes are deliberately
-- completed by `npm run finalize:memory-lifecycle`, outside the
-- transaction-wrapped migration runner.
