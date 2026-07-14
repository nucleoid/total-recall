-- Provenance-preserving memory consolidation (#54). This is additive and does
-- not enable generation or consolidation writes by itself.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS consolidated_into_id UUID,
  ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE public.memories ADD CONSTRAINT memories_consolidated_into_id_fkey
    FOREIGN KEY (consolidated_into_id) REFERENCES public.memories(id)
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.memories ADD CONSTRAINT memories_consolidated_not_self
    CHECK (consolidated_into_id IS NULL OR consolidated_into_id <> id) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.memories ADD CONSTRAINT memories_consolidated_columns_together
    CHECK ((consolidated_into_id IS NULL) = (consolidated_at IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS memories_consolidated_into_idx
  ON public.memories (consolidated_into_id) WHERE consolidated_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.memory_consolidation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'normal' CHECK (access_level = 'normal'),
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  mode TEXT NOT NULL CHECK (mode IN ('apply')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  anchors_examined INTEGER NOT NULL DEFAULT 0 CHECK (anchors_examined >= 0),
  provider_calls INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0),
  clusters_merged INTEGER NOT NULL DEFAULT 0 CHECK (clusters_merged >= 0),
  input_bytes BIGINT NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
  output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  estimated_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_micro_usd >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.memory_consolidation_checkpoints (
  owner_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'normal' CHECK (access_level = 'normal'),
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  cursor_created_at TIMESTAMPTZ,
  cursor_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (owner_key_id, namespace, access_level, embedding_provider, embedding_model, embedding_dimensions),
  CHECK ((cursor_created_at IS NULL) = (cursor_id IS NULL))
);

CREATE TABLE IF NOT EXISTS public.memory_consolidation_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'normal' CHECK (access_level = 'normal'),
  run_id UUID REFERENCES public.memory_consolidation_runs(id) ON DELETE RESTRICT,
  canonical_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE RESTRICT,
  member_revision INTEGER NOT NULL CHECK (member_revision >= 0),
  member_fingerprint TEXT NOT NULL CHECK (member_fingerprint ~ '^[0-9a-f]{64}$'),
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  consolidated_at TIMESTAMPTZ NOT NULL,
  deconsolidated_at TIMESTAMPTZ,
  CHECK (canonical_id <> member_id),
  CHECK (deconsolidated_at IS NULL OR deconsolidated_at >= consolidated_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_consolidation_active_member_unique
  ON public.memory_consolidation_memberships (member_id) WHERE deconsolidated_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_consolidation_canonical_idx
  ON public.memory_consolidation_memberships (canonical_id, consolidated_at);
CREATE INDEX IF NOT EXISTS memory_consolidation_temporal_member_idx
  ON public.memory_consolidation_memberships (member_id, consolidated_at, deconsolidated_at);

-- Cross-row invariants are checked at commit, allowing one transaction to insert
-- the canonical/history and then link every member in deterministic order.
CREATE OR REPLACE FUNCTION public.validate_memory_consolidation_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_row public.memories%ROWTYPE; canonical_row public.memories%ROWTYPE;
BEGIN
  SELECT * INTO member_row FROM public.memories WHERE id = NEW.member_id;
  SELECT * INTO canonical_row FROM public.memories WHERE id = NEW.canonical_id;
  IF member_row.id IS NULL OR canonical_row.id IS NULL
     OR member_row.namespace <> NEW.namespace OR canonical_row.namespace <> NEW.namespace
     OR member_row.access_level <> NEW.access_level OR canonical_row.access_level <> NEW.access_level
     OR member_row.memory_kind <> 'semantic' OR canonical_row.memory_kind <> 'consolidation'
     OR canonical_row.source <> 'memory-consolidation'
     OR canonical_row.client_id <> NEW.owner_key_id::text
     OR NEW.embedding_provider IS DISTINCT FROM member_row.embedding_provider
     OR NEW.embedding_model IS DISTINCT FROM member_row.embedding_model
     OR NEW.embedding_dimensions IS DISTINCT FROM member_row.embedding_dimensions
     OR member_row.embedding_provider IS DISTINCT FROM canonical_row.embedding_provider
     OR member_row.embedding_model IS DISTINCT FROM canonical_row.embedding_model
     OR member_row.embedding_dimensions IS DISTINCT FROM canonical_row.embedding_dimensions THEN
    RAISE EXCEPTION 'invalid memory consolidation membership' USING ERRCODE = '23514';
  END IF;
  IF NEW.deconsolidated_at IS NULL AND
     (member_row.consolidated_into_id IS DISTINCT FROM NEW.canonical_id OR
      member_row.consolidated_at IS DISTINCT FROM NEW.consolidated_at OR
      member_row.deleted_at IS NOT NULL OR member_row.superseded_at IS NOT NULL OR member_row.valid_to IS NOT NULL OR
      canonical_row.deleted_at IS NOT NULL OR canonical_row.superseded_at IS NOT NULL OR canonical_row.valid_to IS NOT NULL OR
      member_row.revision <> NEW.member_revision + 1) THEN
    RAISE EXCEPTION 'active membership does not match memory consolidation link' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.validate_memory_consolidation_link()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consolidated_into_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memory_consolidation_memberships cm
    WHERE cm.member_id = NEW.id AND cm.canonical_id = NEW.consolidated_into_id
      AND cm.consolidated_at = NEW.consolidated_at AND cm.deconsolidated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'memory consolidation link lacks active membership' USING ERRCODE = '23514';
  END IF;
  IF NEW.consolidated_into_id IS NULL AND EXISTS (
    SELECT 1 FROM public.memory_consolidation_memberships cm
    WHERE cm.member_id = NEW.id AND cm.deconsolidated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active membership lacks memory consolidation link' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS memory_consolidation_membership_constraint ON public.memory_consolidation_memberships;
CREATE CONSTRAINT TRIGGER memory_consolidation_membership_constraint
AFTER INSERT OR UPDATE ON public.memory_consolidation_memberships
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.validate_memory_consolidation_membership();
DROP TRIGGER IF EXISTS memory_consolidation_link_constraint ON public.memories;
CREATE CONSTRAINT TRIGGER memory_consolidation_link_constraint
AFTER UPDATE OF consolidated_into_id, consolidated_at ON public.memories
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.validate_memory_consolidation_link();

-- Consolidation links are lifecycle changes and therefore advance the
-- trigger-owned revision used by optimistic writers and source keys.
CREATE OR REPLACE FUNCTION public.bump_memory_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.supersedes_id IS NOT NULL AND NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'memory supersedes_id is immutable once set' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'memory superseded_at is immutable once set' USING ERRCODE = '23514';
  END IF;
  IF OLD.content IS DISTINCT FROM NEW.content OR OLD.tags IS DISTINCT FROM NEW.tags
     OR OLD.metadata IS DISTINCT FROM NEW.metadata OR OLD.supersedes_id IS DISTINCT FROM NEW.supersedes_id
     OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at
     OR OLD.consolidated_into_id IS DISTINCT FROM NEW.consolidated_into_id
     OR OLD.consolidated_at IS DISTINCT FROM NEW.consolidated_at THEN
    NEW.revision := OLD.revision + 1;
  ELSE NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE public.memory_consolidation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_consolidation_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_consolidation_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY consolidation_runs_read ON public.memory_consolidation_runs FOR SELECT
  USING (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_runs_insert ON public.memory_consolidation_runs FOR INSERT
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_runs_update ON public.memory_consolidation_runs FOR UPDATE
  USING (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_checkpoints_read ON public.memory_consolidation_checkpoints FOR SELECT
  USING (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_checkpoints_insert ON public.memory_consolidation_checkpoints FOR INSERT
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_checkpoints_update ON public.memory_consolidation_checkpoints FOR UPDATE
  USING (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
-- Every reader in a namespace needs history to apply temporal visibility.
CREATE POLICY consolidation_memberships_read ON public.memory_consolidation_memberships FOR SELECT
  USING (namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_memberships_insert ON public.memory_consolidation_memberships FOR INSERT
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY consolidation_memberships_update ON public.memory_consolidation_memberships FOR UPDATE
  USING (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (owner_key_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));

GRANT SELECT, INSERT, UPDATE ON public.memory_consolidation_runs TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.memory_consolidation_checkpoints TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.memory_consolidation_memberships TO total_recall_app;
-- Deliberately no DELETE on provenance/history tables.
