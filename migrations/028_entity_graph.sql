-- Namespace-scoped entity graph and durable, provider-neutral enrichment queue (#55).
-- The trigger only maintains queue state; migrations never call a provider or backfill history.
ALTER TABLE public.memories
  ADD COLUMN entity_source_revision INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT memories_entity_source_revision_nonnegative CHECK (entity_source_revision >= 0),
  ADD CONSTRAINT memories_namespace_id_unique UNIQUE (namespace, id);

CREATE TABLE public.entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('person', 'project', 'tool', 'place')),
  normalized_name TEXT NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 256),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (namespace, type, normalized_name),
  UNIQUE (namespace, id)
);

CREATE TABLE public.memory_entities (
  namespace TEXT NOT NULL,
  memory_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  mention TEXT NOT NULL CHECK (char_length(mention) BETWEEN 1 AND 512),
  aliases TEXT[] NOT NULL DEFAULT '{}',
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (namespace, memory_id, entity_id),
  FOREIGN KEY (namespace, memory_id) REFERENCES public.memories(namespace, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (namespace, entity_id) REFERENCES public.entities(namespace, id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CHECK (cardinality(aliases) <= 20)
);
CREATE INDEX memory_entities_entity_idx ON public.memory_entities (namespace, entity_id, memory_id);

CREATE TABLE public.entity_enrichment_queue (
  memory_id UUID PRIMARY KEY,
  namespace TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  source_updated_at TIMESTAMPTZ NOT NULL,
  source_content_hash TEXT NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{32}$'),
  source_access_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  locked_at TIMESTAMPTZ,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (namespace, memory_id),
  FOREIGN KEY (namespace, memory_id) REFERENCES public.memories(namespace, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.-]{1,64}$')
);
CREATE INDEX entity_enrichment_claim_idx ON public.entity_enrichment_queue
  (next_attempt_at, created_at, memory_id) WHERE status IN ('pending', 'retry', 'processing');

-- Remove links before a namespace move so both composite tenant FKs remain valid.
CREATE OR REPLACE FUNCTION public.prepare_memory_entity_source_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.access_level IS DISTINCT FROM OLD.access_level THEN
    IF OLD.entity_source_revision = 2147483647 THEN
      RAISE EXCEPTION 'memory entity source revision exhausted' USING ERRCODE = '22003';
    END IF;
    NEW.entity_source_revision := OLD.entity_source_revision + 1;
  ELSE
    -- The source revision is trigger-owned and cannot be advanced independently.
    NEW.entity_source_revision := OLD.entity_source_revision;
  END IF;
  IF session_user = 'total_recall_app' AND NEW.namespace IS DISTINCT FROM OLD.namespace
     AND NOT (NEW.namespace = ANY(public.app_allowed_namespaces())) THEN
    RAISE EXCEPTION 'entity graph namespace move is outside request scope' USING ERRCODE = '42501';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.access_level IS DISTINCT FROM OLD.access_level THEN
    -- Never serve stale links while eventually-consistent re-indexing is pending.
    DELETE FROM public.memory_entities WHERE namespace = OLD.namespace AND memory_id = OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS memories_entity_source_change ON public.memories;
CREATE TRIGGER memories_entity_source_change
BEFORE UPDATE OF content, namespace, access_level, entity_source_revision ON public.memories FOR EACH ROW
EXECUTE FUNCTION public.prepare_memory_entity_source_change();

CREATE OR REPLACE FUNCTION public.enqueue_memory_entity_enrichment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.access_level IS DISTINCT FROM OLD.access_level THEN
    INSERT INTO public.entity_enrichment_queue (
      memory_id, namespace, source_revision, source_updated_at, source_content_hash,
      source_access_level, status, attempts, next_attempt_at, locked_at,
      last_error_code, completed_at, updated_at
    ) VALUES (
      NEW.id, NEW.namespace, NEW.entity_source_revision, COALESCE(NEW.updated_at, statement_timestamp()), md5(NEW.content),
      COALESCE(NEW.access_level, 'normal'), 'pending', 0, statement_timestamp(), NULL,
      NULL, NULL, statement_timestamp()
    )
    ON CONFLICT (memory_id) DO UPDATE SET
      namespace = EXCLUDED.namespace,
      source_revision = EXCLUDED.source_revision,
      source_updated_at = EXCLUDED.source_updated_at,
      source_content_hash = EXCLUDED.source_content_hash,
      source_access_level = EXCLUDED.source_access_level,
      status = 'pending', attempts = 0, next_attempt_at = statement_timestamp(),
      locked_at = NULL, last_error_code = NULL, completed_at = NULL,
      updated_at = statement_timestamp();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS memories_entity_enrichment_enqueue ON public.memories;
CREATE TRIGGER memories_entity_enrichment_enqueue
AFTER INSERT OR UPDATE OF content, namespace, access_level ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.enqueue_memory_entity_enrichment();

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_enrichment_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY entities_namespace_all ON public.entities
  USING (namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_entities_namespace_all ON public.memory_entities
  USING (namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY entity_enrichment_queue_namespace_all ON public.entity_enrichment_queue
  USING (namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (namespace = ANY(public.app_allowed_namespaces()));

GRANT SELECT, INSERT, UPDATE ON public.entities TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_entities TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.entity_enrichment_queue TO total_recall_app;
-- Queue deletion and entity deletion are intentionally unavailable to runtime identities.
