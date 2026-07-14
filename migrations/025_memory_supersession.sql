-- Durable memory revision and supersession lifecycle (#52).
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS supersedes_id UUID,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_supersedes_not_self
    CHECK (supersedes_id IS NULL OR supersedes_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.memories
    ADD CONSTRAINT memories_supersedes_id_fkey
    FOREIGN KEY (supersedes_id)
    REFERENCES public.memories(id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- This is deliberately non-partial: deleting a successor must not permit a
-- second successor or silently reopen the predecessor's history.
CREATE UNIQUE INDEX IF NOT EXISTS memories_supersedes_id_unique
  ON public.memories (supersedes_id);
CREATE INDEX IF NOT EXISTS memories_superseded_at_idx
  ON public.memories (superseded_at)
  WHERE superseded_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bump_memory_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.supersedes_id IS NOT NULL AND NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'memory supersedes_id is immutable once set' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'memory superseded_at is immutable once set' USING ERRCODE = '23514';
  END IF;

  IF OLD.content IS DISTINCT FROM NEW.content
     OR OLD.tags IS DISTINCT FROM NEW.tags
     OR OLD.metadata IS DISTINCT FROM NEW.metadata
     OR OLD.supersedes_id IS DISTINCT FROM NEW.supersedes_id
     OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    -- The revision is trigger-owned, including for direct/source-key writers.
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_revision_trigger ON public.memories;
CREATE TRIGGER memories_revision_trigger
BEFORE UPDATE ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.bump_memory_revision();
