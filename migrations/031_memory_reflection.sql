-- Cross-cutting reflection insights (#58). This migration is deliberately
-- provider-neutral and leaves the reflection CLI disabled until four explicit
-- approvals and a narrow reflection key are configured.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.memories WHERE namespace = 'insights') THEN
    RAISE EXCEPTION 'legacy insights rows require reviewed origin_namespace classification before migration 031';
  END IF;
END $$;

ALTER TABLE public.memories
  ADD COLUMN origin_namespace TEXT,
  ADD COLUMN insight_content_hash TEXT;

ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_memory_kind_check;
ALTER TABLE public.memories ADD CONSTRAINT memories_memory_kind_check
  CHECK (memory_kind IN (
    'unspecified', 'semantic', 'document_chunk', 'episode_chunk', 'synced',
    'media_rollup', 'consolidation', 'insight'
  )) NOT VALID;
ALTER TABLE public.memories ADD CONSTRAINT memories_insight_shape_check CHECK (
  (namespace = 'insights' AND memory_kind = 'insight'
    AND origin_namespace IS NOT NULL AND origin_namespace <> 'insights'
    AND insight_content_hash ~ '^[0-9a-f]{64}$'
    AND source = 'memory-reflection')
  OR
  (namespace <> 'insights' AND memory_kind <> 'insight'
    AND origin_namespace IS NULL AND insight_content_hash IS NULL)
) NOT VALID;
ALTER TABLE public.memories ADD CONSTRAINT memories_insight_origin_not_empty_check
  CHECK (origin_namespace IS NULL OR (origin_namespace = btrim(origin_namespace)
    AND origin_namespace <> '' AND origin_namespace !~ ',')) NOT VALID;
CREATE UNIQUE INDEX memories_active_insight_content_identity_unique
  ON public.memories (
    origin_namespace, insight_content_hash,
    embedding_provider, embedding_model, embedding_dimensions
  ) WHERE namespace = 'insights' AND memory_kind = 'insight' AND deleted_at IS NULL;
CREATE INDEX memories_insight_origin_idx
  ON public.memories (origin_namespace, created_at DESC)
  WHERE namespace = 'insights';

CREATE TABLE public.memory_reflection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  origin_namespace TEXT NOT NULL CHECK (origin_namespace = btrim(origin_namespace)
    AND origin_namespace <> '' AND origin_namespace <> 'insights' AND origin_namespace !~ ','),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  provider_calls INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0),
  input_bytes BIGINT NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
  output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  insights_stored INTEGER NOT NULL DEFAULT 0 CHECK (insights_stored >= 0),
  estimated_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_micro_usd >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (origin_namespace, window_start, window_end, config_hash, generation),
  UNIQUE (origin_namespace, id),
  CHECK (window_start < window_end),
  CHECK ((status IN ('completed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK (status <> 'completed' OR last_error_code IS NULL)
);
CREATE INDEX memory_reflection_monthly_budget_idx
  ON public.memory_reflection_runs (origin_namespace, provider, model, started_at)
  WHERE estimated_cost_micro_usd > 0;

CREATE TABLE public.memory_insight_evidence (
  insight_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE RESTRICT,
  evidence_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE RESTRICT,
  origin_namespace TEXT NOT NULL,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (insight_id, evidence_id),
  FOREIGN KEY (origin_namespace, run_id)
    REFERENCES public.memory_reflection_runs(origin_namespace, id) ON DELETE RESTRICT,
  CHECK (insight_id <> evidence_id)
);
CREATE INDEX memory_insight_evidence_source_idx
  ON public.memory_insight_evidence (evidence_id, insight_id);

-- Purpose-specific cross-row checks prevent forged or cross-origin provenance.
CREATE OR REPLACE FUNCTION public.validate_memory_insight_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE insight_row public.memories%ROWTYPE; evidence_row public.memories%ROWTYPE;
BEGIN
  SELECT * INTO insight_row FROM public.memories WHERE id = NEW.insight_id;
  SELECT * INTO evidence_row FROM public.memories WHERE id = NEW.evidence_id;
  IF insight_row.id IS NULL OR evidence_row.id IS NULL
     OR insight_row.namespace <> 'insights' OR insight_row.memory_kind <> 'insight'
     OR insight_row.origin_namespace <> NEW.origin_namespace
     OR evidence_row.namespace <> NEW.origin_namespace
     OR evidence_row.namespace = 'insights' OR evidence_row.memory_kind IN ('document_chunk', 'episode_chunk', 'insight')
     OR evidence_row.deleted_at IS NOT NULL
     OR CASE insight_row.access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
        < CASE evidence_row.access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END THEN
    RAISE EXCEPTION 'invalid insight evidence relationship' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_insight_evidence_validate
BEFORE INSERT OR UPDATE ON public.memory_insight_evidence
FOR EACH ROW EXECUTE FUNCTION public.validate_memory_insight_evidence();

CREATE OR REPLACE FUNCTION public.app_current_key_has_permission(required_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_keys
    WHERE id::text = public.app_current_key_id() AND enabled = true
      AND required_permission = ANY(permissions)
  )
$$;
REVOKE ALL ON FUNCTION public.app_current_key_has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_current_key_has_permission(text) TO total_recall_app;

-- Insights require both the dedicated namespace and their origin namespace.
DROP POLICY IF EXISTS namespace_read ON public.memories;
CREATE POLICY namespace_read ON public.memories FOR SELECT USING (
  namespace = ANY(public.app_allowed_namespaces())
  AND (namespace <> 'insights' OR origin_namespace = ANY(public.app_allowed_namespaces()))
);
DROP POLICY IF EXISTS namespace_insert ON public.memories;
CREATE POLICY namespace_insert ON public.memories FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('reflection')
  AND namespace = ANY(public.app_allowed_namespaces())
  AND namespace <> 'insights' AND origin_namespace IS NULL AND insight_content_hash IS NULL
);
CREATE POLICY reflection_insight_insert ON public.memories FOR INSERT WITH CHECK (
  public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('write')
  AND namespace = 'insights' AND namespace = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
  AND memory_kind = 'insight' AND source = 'memory-reflection'
  AND access_level = 'normal' AND client_id = public.app_current_key_id()
);
DROP POLICY IF EXISTS namespace_update ON public.memories;
CREATE POLICY namespace_update ON public.memories FOR UPDATE
  USING (NOT public.app_current_key_has_permission('reflection') AND namespace <> 'insights'
    AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('reflection') AND namespace <> 'insights'
    AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS namespace_delete ON public.memories;
CREATE POLICY namespace_delete ON public.memories FOR DELETE
  USING (NOT public.app_current_key_has_permission('reflection') AND namespace <> 'insights'
    AND namespace = ANY(public.app_allowed_namespaces()));

ALTER TABLE public.memory_reflection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_insight_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY reflection_runs_read ON public.memory_reflection_runs FOR SELECT USING (
  owner_key_id = public.app_current_key_id()::uuid
  AND 'insights' = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
);
CREATE POLICY reflection_runs_insert ON public.memory_reflection_runs FOR INSERT WITH CHECK (
  owner_key_id = public.app_current_key_id()::uuid
  AND public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('write')
  AND 'insights' = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
);
CREATE POLICY reflection_runs_update ON public.memory_reflection_runs FOR UPDATE
  USING (owner_key_id = public.app_current_key_id()::uuid
    AND public.app_current_key_has_permission('reflection')
    AND origin_namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (owner_key_id = public.app_current_key_id()::uuid
    AND public.app_current_key_has_permission('reflection')
    AND origin_namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY insight_evidence_read ON public.memory_insight_evidence FOR SELECT USING (
  'insights' = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
);
CREATE POLICY insight_evidence_insert ON public.memory_insight_evidence FOR INSERT WITH CHECK (
  public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('write')
  AND 'insights' = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
);

GRANT SELECT, INSERT, UPDATE ON public.memory_reflection_runs TO total_recall_app;
GRANT SELECT, INSERT ON public.memory_insight_evidence TO total_recall_app;
-- No runtime DELETE is granted for reflection runs or evidence.

-- Reflection has its own validated model provenance. Do not enqueue derived
-- beliefs for a second generative extraction feature under an unrelated
-- approval; readers can still traverse their explicit evidence links.
DROP TRIGGER IF EXISTS memories_entity_enrichment_enqueue ON public.memories;
CREATE TRIGGER memories_entity_enrichment_enqueue
AFTER INSERT OR UPDATE OF content, namespace, access_level ON public.memories
FOR EACH ROW WHEN (NEW.memory_kind NOT IN ('episode_chunk', 'insight'))
EXECUTE FUNCTION public.enqueue_memory_entity_enrichment();

CREATE OR REPLACE FUNCTION public.audit_reflection_run_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed', 'cancelled') THEN
    INSERT INTO public.audit_log (client_id, action, namespace, result_count)
    VALUES (NEW.owner_key_id::text,
      CASE NEW.status WHEN 'completed' THEN 'reflection.completed' ELSE 'reflection.cancelled' END,
      NEW.origin_namespace, NEW.insights_stored);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.audit_reflection_run_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_reflection_run_transition() FROM total_recall_app;
CREATE TRIGGER memory_reflection_run_audit
AFTER UPDATE OF status ON public.memory_reflection_runs
FOR EACH ROW EXECUTE FUNCTION public.audit_reflection_run_transition();
