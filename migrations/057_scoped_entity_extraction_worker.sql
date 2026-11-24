-- Dedicated, non-admin entity extraction lane. Ordinary callers retain the
-- migration-028 namespace behavior; entity workers receive only provenance-bound mutation.

CREATE OR REPLACE FUNCTION public.app_entity_extract_scope_allowed(p_namespace text, p_access_level text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT public.app_current_key_has_permission('entity_extract')
    AND public.app_current_key_has_permission('read')
    AND NOT public.app_current_key_has_permission('write')
    AND NOT public.app_current_key_has_permission('admin')
    AND NOT public.app_current_key_has_permission('delete')
    AND p_namespace = ANY(public.app_allowed_namespaces())
    AND EXISTS (SELECT 1 FROM public.api_keys key
      WHERE key.id::text = public.app_current_key_id() AND key.enabled
        AND key.revoked_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
        AND p_namespace = ANY(key.namespaces)
        AND CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
          <= CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END)
$$;
REVOKE ALL ON FUNCTION public.app_entity_extract_scope_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_entity_extract_scope_allowed(text, text) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.app_current_key_read_scope_allowed(p_namespace text, p_access_level text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT public.app_current_key_has_permission('read')
    AND p_namespace = ANY(public.app_allowed_namespaces())
    AND EXISTS (SELECT 1 FROM public.api_keys key
      WHERE key.id::text = public.app_current_key_id() AND key.enabled
        AND key.revoked_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
        AND p_namespace = ANY(key.namespaces)
        AND CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
          <= CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END)
$$;
REVOKE ALL ON FUNCTION public.app_current_key_read_scope_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_current_key_read_scope_allowed(text, text) TO total_recall_app;

-- Entity workers cannot use the ordinary source-memory or document mutation lanes.
DROP POLICY IF EXISTS namespace_insert ON public.memories;
CREATE POLICY namespace_insert ON public.memories FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('session_distill')
  AND NOT public.app_current_key_has_permission('entity_extract')
  AND namespace = ANY(public.app_allowed_namespaces())
  AND namespace <> 'insights' AND origin_namespace IS NULL AND insight_content_hash IS NULL);
DROP POLICY IF EXISTS namespace_update ON public.memories;
CREATE POLICY namespace_update ON public.memories FOR UPDATE
  USING (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS namespace_delete ON public.memories;
CREATE POLICY namespace_delete ON public.memories FOR DELETE
  USING (NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace <> 'insights' AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS entity_extraction_source_lock ON public.memories;
CREATE POLICY entity_extraction_source_lock ON public.memories FOR UPDATE
  USING (public.app_entity_extract_scope_allowed(namespace, access_level)
    AND EXISTS (SELECT 1 FROM public.entity_enrichment_queue q
      WHERE q.memory_id = memories.id AND q.namespace = memories.namespace
        AND q.source_access_level = memories.access_level AND q.status = 'processing'))
  WITH CHECK (false);

DROP POLICY IF EXISTS namespace_insert ON public.documents;
CREATE POLICY namespace_insert ON public.documents FOR INSERT
  WITH CHECK (NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS namespace_update ON public.documents;
CREATE POLICY namespace_update ON public.documents FOR UPDATE
  USING (NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND namespace = ANY(public.app_allowed_namespaces()));

-- Global entity labels must never retain source-only spelling/casing. Mentions and
-- aliases remain on access-filtered links.
UPDATE public.entities SET display_name = normalized_name
WHERE display_name IS DISTINCT FROM normalized_name;

CREATE OR REPLACE FUNCTION public.app_entity_visible(p_entity_id uuid, p_namespace text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memory_entities me
    JOIN public.memories m ON m.id = me.memory_id AND m.namespace = me.namespace
    WHERE me.entity_id = p_entity_id AND me.namespace = p_namespace
      AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
      AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL
      AND public.app_current_key_read_scope_allowed(m.namespace, m.access_level)
  )
$$;
REVOKE ALL ON FUNCTION public.app_entity_visible(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_entity_visible(uuid, text) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.app_entity_memory_has_links(
  p_memory_id uuid, p_namespace text, p_access_level text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN public.app_entity_extract_scope_allowed(p_namespace, p_access_level)
    THEN EXISTS (SELECT 1 FROM public.memory_entities me
      WHERE me.memory_id = p_memory_id AND me.namespace = p_namespace)
    ELSE false END
$$;
REVOKE ALL ON FUNCTION public.app_entity_memory_has_links(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_entity_memory_has_links(uuid, text, text) TO total_recall_app;

-- Preserve ordinary graph mutations while separating reads by linked source level.
DROP POLICY IF EXISTS entities_namespace_all ON public.entities;
CREATE POLICY entities_namespace_read ON public.entities FOR SELECT USING (
  NOT public.app_current_key_has_permission('entity_extract')
  AND public.app_entity_visible(id, namespace));
CREATE POLICY entities_namespace_insert ON public.entities FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces())
  AND display_name = normalized_name);
CREATE POLICY entities_namespace_update ON public.entities FOR UPDATE
  USING (NOT public.app_current_key_has_permission('entity_extract') AND public.app_entity_visible(id, namespace))
  WITH CHECK (NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces())
    AND display_name = normalized_name);
DROP POLICY IF EXISTS entity_worker_read ON public.entities;
DROP POLICY IF EXISTS entity_worker_insert ON public.entities;

CREATE OR REPLACE FUNCTION public.resolve_entity_extraction_identity(
  p_namespace text, p_access_level text, p_type text, p_normalized_name text, p_display_name text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE resolved_id uuid;
BEGIN
  IF NOT public.app_entity_extract_scope_allowed(p_namespace, p_access_level)
     OR NOT EXISTS (SELECT 1 FROM public.entity_enrichment_queue q
       WHERE q.namespace = p_namespace AND q.source_access_level = p_access_level AND q.status = 'processing') THEN
    RAISE EXCEPTION 'entity identity resolution is not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.entities(namespace, type, normalized_name, display_name)
  VALUES(p_namespace, p_type, p_normalized_name, p_normalized_name)
  ON CONFLICT(namespace, type, normalized_name) DO NOTHING
  RETURNING id INTO resolved_id;
  IF resolved_id IS NULL THEN
    SELECT id INTO resolved_id FROM public.entities
    WHERE namespace = p_namespace AND type = p_type AND normalized_name = p_normalized_name;
  END IF;
  RETURN resolved_id;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_entity_extraction_identity(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_entity_extraction_identity(text, text, text, text, text) TO total_recall_app;

DROP POLICY IF EXISTS memory_entities_namespace_all ON public.memory_entities;
CREATE POLICY memory_entities_namespace_read ON public.memory_entities FOR SELECT USING (
  NOT public.app_current_key_has_permission('entity_extract')
  AND EXISTS (SELECT 1 FROM public.memories m
    WHERE m.id = memory_entities.memory_id AND m.namespace = memory_entities.namespace
      AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
      AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL
      AND public.app_current_key_read_scope_allowed(m.namespace, m.access_level)));
CREATE POLICY memory_entities_namespace_insert ON public.memory_entities FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_entities_namespace_update ON public.memory_entities FOR UPDATE
  USING (NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_entities_namespace_delete ON public.memory_entities FOR DELETE USING (
  NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS entity_worker_links_read ON public.memory_entities;
CREATE POLICY entity_worker_links_read ON public.memory_entities FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.entity_enrichment_queue q
    WHERE q.memory_id = memory_entities.memory_id AND q.namespace = memory_entities.namespace
      AND q.status = 'processing' AND public.app_entity_extract_scope_allowed(q.namespace, q.source_access_level)));
DROP POLICY IF EXISTS entity_worker_links_insert ON public.memory_entities;
CREATE POLICY entity_worker_links_insert ON public.memory_entities FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.entity_enrichment_queue q JOIN public.memories m
      ON m.id = q.memory_id AND m.namespace = q.namespace
    WHERE q.memory_id = memory_entities.memory_id AND q.namespace = memory_entities.namespace
      AND q.status = 'processing' AND q.source_access_level = m.access_level
      AND public.app_entity_extract_scope_allowed(q.namespace, q.source_access_level)));
DROP POLICY IF EXISTS entity_worker_links_delete ON public.memory_entities;
CREATE POLICY entity_worker_links_delete ON public.memory_entities FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.entity_enrichment_queue q
    WHERE q.memory_id = memory_entities.memory_id AND q.namespace = memory_entities.namespace
      AND q.status = 'processing' AND public.app_entity_extract_scope_allowed(q.namespace, q.source_access_level)));

DROP POLICY IF EXISTS entity_enrichment_queue_namespace_all ON public.entity_enrichment_queue;
CREATE POLICY entity_enrichment_queue_namespace_read ON public.entity_enrichment_queue FOR SELECT USING (
  NOT public.app_current_key_has_permission('entity_extract')
  AND public.app_current_key_read_scope_allowed(namespace, source_access_level));
CREATE POLICY entity_enrichment_queue_namespace_insert ON public.entity_enrichment_queue FOR INSERT WITH CHECK (
  NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY entity_enrichment_queue_namespace_update ON public.entity_enrichment_queue FOR UPDATE
  USING (NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (NOT public.app_current_key_has_permission('entity_extract') AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS entity_worker_queue_read ON public.entity_enrichment_queue;
CREATE POLICY entity_worker_queue_read ON public.entity_enrichment_queue FOR SELECT
  USING (public.app_entity_extract_scope_allowed(namespace, source_access_level));
DROP POLICY IF EXISTS entity_worker_queue_insert ON public.entity_enrichment_queue;
CREATE POLICY entity_worker_queue_insert ON public.entity_enrichment_queue FOR INSERT WITH CHECK (
  public.app_entity_extract_scope_allowed(namespace, source_access_level)
  AND EXISTS (SELECT 1 FROM public.memories m WHERE m.id = entity_enrichment_queue.memory_id
    AND m.namespace = entity_enrichment_queue.namespace
    AND m.entity_source_revision = entity_enrichment_queue.source_revision
    AND md5(m.content) = entity_enrichment_queue.source_content_hash
    AND m.access_level = entity_enrichment_queue.source_access_level));
DROP POLICY IF EXISTS entity_worker_queue_update ON public.entity_enrichment_queue;
CREATE POLICY entity_worker_queue_update ON public.entity_enrichment_queue FOR UPDATE
  USING (public.app_entity_extract_scope_allowed(namespace, source_access_level))
  WITH CHECK (public.app_entity_extract_scope_allowed(namespace, source_access_level)
    AND EXISTS (SELECT 1 FROM public.memories m WHERE m.id = entity_enrichment_queue.memory_id
      AND m.namespace = entity_enrichment_queue.namespace
      AND m.entity_source_revision = entity_enrichment_queue.source_revision
      AND md5(m.content) = entity_enrichment_queue.source_content_hash
      AND m.access_level = entity_enrichment_queue.source_access_level));
