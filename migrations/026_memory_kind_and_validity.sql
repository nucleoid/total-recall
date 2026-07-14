-- Memory classification and half-open belief validity intervals (#53).
--
-- This migration follows #52's memory supersession migration. valid_from remains
-- nullable until the bounded backfill and separate owner-run finalizer complete.
-- New writers supply statement_timestamp() explicitly.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS memory_kind TEXT NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;

-- #53 builds on #52's durable supersession contract. These additions remain
-- idempotent for stacked-branch convergence; production must still apply and
-- finalize #52 first.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS supersedes_id UUID,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- This default affects only rows inserted after the additive ALTER. Existing
-- rows remain NULL and are handled by the bounded backfill.
ALTER TABLE public.memories
  ALTER COLUMN valid_from SET DEFAULT statement_timestamp();

-- Keep #52 manual supersession writers compatible during rolling deployment.
-- They already choose the durable database timestamp; copy that exact value into
-- the validity interval before deferred equality validation is enabled.
CREATE OR REPLACE FUNCTION public.sync_memory_valid_to_from_supersession()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.superseded_at IS NOT NULL AND NEW.valid_to IS NULL THEN
    NEW.valid_to := NEW.superseded_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_validity_sync_trigger ON public.memories;
CREATE TRIGGER memories_validity_sync_trigger
BEFORE INSERT OR UPDATE OF superseded_at, valid_to ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.sync_memory_valid_to_from_supersession();

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

-- The valid_from presence, interval, and validity/supersession equality checks
-- are added only by the finalizer after backfill. NOT VALID checks still apply
-- to updated legacy rows, so adding them here would break #52 writers during
-- the rollout.
--
-- The canonical non-partial memories_supersedes_id_unique index is verified or
-- idempotently created by the owner-run finalizer with CREATE UNIQUE INDEX
-- CONCURRENTLY. Keeping it out of this
-- transaction-wrapped migration avoids a table-wide blocking index build.
