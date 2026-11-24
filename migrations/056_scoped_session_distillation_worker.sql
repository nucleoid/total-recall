-- Replace the broad admin session-distillation lane with a dedicated, scoped
-- cross-owner worker permission. This migration grants no ordinary write path.

CREATE OR REPLACE FUNCTION public.app_session_distill_scope_allowed(p_namespace text, p_access_level text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT public.app_current_key_has_permission('session_distill')
    AND public.app_current_key_has_permission('read')
    AND NOT public.app_current_key_has_permission('write')
    AND NOT public.app_current_key_has_permission('admin')
    AND NOT public.app_current_key_has_permission('delete')
    AND p_namespace = ANY(public.app_allowed_namespaces())
    AND EXISTS (
      SELECT 1 FROM public.api_keys key
      WHERE key.id::text = public.app_current_key_id() AND key.enabled = true
        AND key.revoked_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
        AND p_namespace = ANY(key.namespaces)
        AND CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
          <= CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    )
$$;
REVOKE ALL ON FUNCTION public.app_session_distill_scope_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_session_distill_scope_allowed(text, text) TO total_recall_app;

DROP POLICY IF EXISTS memory_session_runs_worker_read ON public.memory_session_distillation_runs;
CREATE POLICY memory_session_runs_worker_read ON public.memory_session_distillation_runs FOR SELECT
  USING (public.app_session_distill_scope_allowed(namespace, access_level));
DROP POLICY IF EXISTS memory_session_runs_worker_update ON public.memory_session_distillation_runs;
CREATE POLICY memory_session_runs_worker_update ON public.memory_session_distillation_runs FOR UPDATE
  USING (public.app_session_distill_scope_allowed(namespace, access_level))
  WITH CHECK (public.app_session_distill_scope_allowed(namespace, access_level));

CREATE OR REPLACE FUNCTION public.preserve_session_distillation_run_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_key_id IS DISTINCT FROM OLD.owner_key_id
     OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.access_level IS DISTINCT FROM OLD.access_level
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'session distillation run identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.preserve_session_distillation_run_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preserve_session_distillation_run_identity() FROM total_recall_app;
DROP TRIGGER IF EXISTS preserve_session_distillation_run_identity ON public.memory_session_distillation_runs;
CREATE TRIGGER preserve_session_distillation_run_identity BEFORE UPDATE ON public.memory_session_distillation_runs
FOR EACH ROW EXECUTE FUNCTION public.preserve_session_distillation_run_identity();

-- A distillation key processes owner-created runs; it cannot manufacture a run
-- merely because it is allowed to read that namespace.
DROP POLICY IF EXISTS memory_session_runs_owner_insert ON public.memory_session_distillation_runs;
CREATE POLICY memory_session_runs_owner_insert ON public.memory_session_distillation_runs FOR INSERT
  WITH CHECK (NOT public.app_current_key_has_permission('session_distill')
    AND owner_key_id = public.app_current_key_id()::uuid
    AND namespace = ANY(public.app_allowed_namespaces()));

-- Likewise, session episodes remain owner-created through memory_store_session.
-- The worker receives only a provenance-bound row-lock path below.
DROP POLICY IF EXISTS namespace_insert ON public.documents;
CREATE POLICY namespace_insert ON public.documents FOR INSERT
  WITH CHECK (NOT public.app_current_key_has_permission('session_distill')
    AND namespace = ANY(public.app_allowed_namespaces()));

-- A worker may row-lock only session documents backing its currently processing runs.
DROP POLICY IF EXISTS namespace_update ON public.documents;
CREATE POLICY namespace_update ON public.documents FOR UPDATE
  USING (NOT public.app_current_key_has_permission('session_distill')
    AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('session_distill')
    AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS session_distillation_document_lock ON public.documents;
CREATE POLICY session_distillation_document_lock ON public.documents FOR UPDATE
  USING (document_kind = 'session' AND public.app_session_distill_scope_allowed(namespace, access_level)
    AND EXISTS (SELECT 1 FROM public.memory_session_distillation_runs run
      WHERE run.episode_id = documents.id AND run.owner_key_id = documents.client_id
        AND run.status = 'processing' AND run.namespace = documents.namespace
        AND run.access_level = documents.access_level))
  WITH CHECK (false);

-- Exclude the dedicated worker from ordinary memory insertion/update. It gets
-- only provenance-bound fact insertion and read-only evidence row locks.
DROP POLICY IF EXISTS namespace_insert ON public.memories;
CREATE POLICY namespace_insert ON public.memories FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('session_distill')
  AND namespace = ANY(public.app_allowed_namespaces())
  AND namespace <> 'insights' AND origin_namespace IS NULL AND insight_content_hash IS NULL
);
DROP POLICY IF EXISTS namespace_update ON public.memories;
CREATE POLICY namespace_update ON public.memories FOR UPDATE
  USING (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS namespace_delete ON public.memories;
CREATE POLICY namespace_delete ON public.memories FOR DELETE
  USING (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()));

DROP POLICY IF EXISTS session_distillation_evidence_lock ON public.memories;
CREATE POLICY session_distillation_evidence_lock ON public.memories FOR UPDATE
  USING (memory_kind = 'episode_chunk' AND document_id IS NOT NULL
    AND public.app_session_distill_scope_allowed(namespace, access_level)
    AND EXISTS (SELECT 1 FROM public.memory_session_distillation_runs run
      WHERE run.episode_id = memories.document_id AND run.owner_key_id::text = memories.client_id
        AND run.status = 'processing' AND run.namespace = memories.namespace
        AND run.access_level = memories.access_level))
  WITH CHECK (false);

DROP POLICY IF EXISTS session_distillation_fact_insert ON public.memories;
CREATE POLICY session_distillation_fact_insert ON public.memories FOR INSERT WITH CHECK (
  source = 'session-distillation' AND memory_kind = 'semantic'
  AND origin_namespace IS NULL AND insight_content_hash IS NULL
  AND source_key LIKE 'session-distillation:v1:%'
  AND metadata->>'run_id' ~ '^[0-9a-f-]{36}$' AND metadata->>'episode_id' ~ '^[0-9a-f-]{36}$'
  AND public.app_session_distill_scope_allowed(namespace, access_level)
  AND EXISTS (
    SELECT 1 FROM public.memory_session_distillation_runs run
    JOIN public.documents episode ON episode.id = run.episode_id AND episode.client_id = run.owner_key_id
    WHERE run.id = (metadata->>'run_id')::uuid AND run.episode_id = (metadata->>'episode_id')::uuid
      AND run.status = 'processing' AND run.owner_key_id::text = memories.client_id
      AND run.namespace = memories.namespace AND run.access_level = memories.access_level
      AND episode.agent_id = memories.agent_id AND episode.session_id IS NOT DISTINCT FROM memories.session_id
  )
);

DROP POLICY IF EXISTS memory_session_derivations_worker_insert ON public.memory_session_derivations;
CREATE POLICY memory_session_derivations_worker_insert ON public.memory_session_derivations FOR INSERT
  WITH CHECK (public.app_session_distill_scope_allowed(namespace, access_level)
    AND EXISTS (SELECT 1 FROM public.memory_session_distillation_runs run
      JOIN public.memories fact ON fact.id = memory_session_derivations.memory_id
      WHERE run.id = memory_session_derivations.run_id AND run.status = 'processing'
        AND run.owner_key_id = memory_session_derivations.owner_key_id
        AND run.owner_key_id::text = memory_session_derivations.owner_client_id
        AND run.episode_id = memory_session_derivations.episode_id
        AND run.namespace = memory_session_derivations.namespace
        AND run.access_level = memory_session_derivations.access_level
        AND fact.client_id = memory_session_derivations.owner_client_id
        AND fact.namespace = memory_session_derivations.namespace
        AND fact.access_level = memory_session_derivations.access_level
        AND fact.source = 'session-distillation'));

-- The derivation is inserted before its durable fact ingestion job. A narrow
-- definer function performs this one cross-owner enqueue without granting the
-- distiller ordinary ingestion-job insertion authority.
DROP POLICY IF EXISTS ingestion_session_fact_insert ON public.memory_ingestion_jobs;
CREATE OR REPLACE FUNCTION public.enqueue_session_distillation_fact(
  p_memory_id uuid, p_namespace text, p_embedding_provider text, p_embedding_model text,
  p_embedding_dimensions integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fact public.memories%ROWTYPE;
BEGIN
  IF p_embedding_dimensions <> 768 OR NOT (
    (p_embedding_provider = 'gemini' AND p_embedding_model = 'gemini-embedding-2-preview')
    OR (p_embedding_provider = 'llama.cpp'
      AND p_embedding_model = 'd38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d')
  ) THEN
    RAISE EXCEPTION 'session distillation embedding descriptor is not supported' USING ERRCODE = '22023';
  END IF;
  SELECT memory.* INTO fact
  FROM public.memories memory
  JOIN public.memory_session_derivations derivation ON derivation.memory_id = memory.id
  JOIN public.memory_session_distillation_runs run ON run.id = derivation.run_id
  WHERE memory.id = p_memory_id AND memory.namespace = p_namespace
    AND memory.source = 'session-distillation' AND memory.memory_kind = 'semantic'
    AND memory.deleted_at IS NULL
    AND derivation.owner_client_id = memory.client_id
    AND derivation.namespace = memory.namespace AND derivation.access_level = memory.access_level
    AND run.status = 'processing' AND run.owner_key_id::text = memory.client_id
    AND run.namespace = memory.namespace AND run.access_level = memory.access_level
    AND public.app_session_distill_scope_allowed(memory.namespace, memory.access_level);
  IF fact.id IS NULL THEN
    RAISE EXCEPTION 'session distillation fact enqueue is not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.memory_ingestion_jobs (
    memory_id, namespace, client_id, access_level, allowed_namespaces, agent_id, session_id, source_key,
    dedupe, contradiction_eligible, embedding_provider, embedding_model, embedding_dimensions, kind, source_revision
  ) VALUES (
    fact.id, fact.namespace, fact.client_id, fact.access_level, ARRAY[fact.namespace], fact.agent_id,
    fact.session_id, fact.source_key, false, false, p_embedding_provider, p_embedding_model,
    p_embedding_dimensions, 'store', fact.revision
  ) ON CONFLICT (memory_id) DO NOTHING;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_session_distillation_fact(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_session_distillation_fact(uuid, text, text, text, integer) TO total_recall_app;
