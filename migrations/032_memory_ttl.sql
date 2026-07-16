-- Ephemeral working memory with database-timed expiry (#60).
-- Expiry is logical at expires_at and physical cleanup is performed by the
-- existing decay/maintenance command.
ALTER TABLE public.memories
  ADD COLUMN expires_at TIMESTAMPTZ;

CREATE INDEX memories_expires_at_idx
  ON public.memories (expires_at)
  WHERE expires_at IS NOT NULL;

-- TTL hard deletion removes content-free relationship rows rather than letting
-- provenance/evidence foreign keys retain ephemeral memory content forever or
-- block cleanup. Parent runs, documents, entities, and media events remain.
DO $$
DECLARE constraint_name name;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.memory_consolidation_memberships'::regclass
      AND confrelid = 'public.memories'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.memory_consolidation_memberships DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE public.memory_consolidation_memberships
  ADD CONSTRAINT memory_consolidation_memberships_canonical_id_fkey
    FOREIGN KEY (canonical_id) REFERENCES public.memories(id) ON DELETE CASCADE,
  ADD CONSTRAINT memory_consolidation_memberships_member_id_fkey
    FOREIGN KEY (member_id) REFERENCES public.memories(id) ON DELETE CASCADE;

DO $$
DECLARE constraint_name name;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.memory_session_derivations'::regclass
      AND confrelid = 'public.memories'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.memory_session_derivations DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE public.memory_session_derivations
  ADD CONSTRAINT memory_session_derivations_owner_memory_fkey
    FOREIGN KEY (owner_client_id, memory_id)
    REFERENCES public.memories(client_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT memory_session_derivations_scope_memory_fkey
    FOREIGN KEY (namespace, access_level, memory_id)
    REFERENCES public.memories(namespace, access_level, id) ON DELETE CASCADE;

DO $$
DECLARE constraint_name name;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.memory_insight_evidence'::regclass
      AND confrelid = 'public.memories'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.memory_insight_evidence DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE public.memory_insight_evidence
  ADD CONSTRAINT memory_insight_evidence_insight_id_fkey
    FOREIGN KEY (insight_id) REFERENCES public.memories(id) ON DELETE CASCADE,
  ADD CONSTRAINT memory_insight_evidence_evidence_id_fkey
    FOREIGN KEY (evidence_id) REFERENCES public.memories(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.memories.expires_at IS
  'Logical expiry instant. Rows are absent when expires_at <= statement_timestamp().';
