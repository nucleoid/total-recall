-- Memory classification and half-open belief validity intervals (#53).
--
-- valid_from remains nullable until the bounded backfill and separate owner-run
-- finalizer complete. New writers supply statement_timestamp() explicitly.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS memory_kind TEXT NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;

-- #53 builds on #52's durable supersession contract. Keep these additions
-- idempotent so this migration is safe both before and after #52 is deployed.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS supersedes_id UUID,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- This default affects only rows inserted after the additive ALTER. Existing
-- rows remain NULL and are handled by the bounded backfill.
ALTER TABLE public.memories
  ALTER COLUMN valid_from SET DEFAULT statement_timestamp();

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_memory_kind_check
    CHECK (memory_kind IN (
      'unspecified', 'semantic', 'document_chunk', 'synced',
      'media_rollup', 'consolidation'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_valid_from_present
    CHECK (valid_from IS NOT NULL)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_validity_interval_check
    CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to > valid_from))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_validity_supersession_check
    CHECK (valid_to IS NOT DISTINCT FROM superseded_at)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_supersedes_not_self
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_supersedes_id_fkey
    FOREIGN KEY (supersedes_id)
    REFERENCES public.memories(id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A predecessor can have at most one durable successor, even if either row is
-- later soft-deleted. New nullable columns make this initial build bounded to a
-- scan of null keys and preserve #52's non-partial uniqueness contract.
CREATE UNIQUE INDEX IF NOT EXISTS memories_supersedes_id_unique_idx
  ON public.memories (supersedes_id);

-- Constraint validation, validity backfill verification, candidate/temporal index builds,
-- and valid_from NOT NULL are deliberately separate owner-run operations.
