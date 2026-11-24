-- Honest entity extraction coverage. Existing done rows intentionally remain
-- unmarked: migration history cannot prove that the extraction contract ran.
ALTER TABLE public.entity_enrichment_queue
  ADD COLUMN extraction_contract text,
  ADD COLUMN extraction_result text,
  ADD CONSTRAINT entity_enrichment_coverage_pair CHECK (
    (extraction_contract IS NULL AND extraction_result IS NULL)
    OR (extraction_contract ~ '^entity-extraction:v[1-9][0-9]*$'
      AND extraction_result IN ('entities','empty'))
  );
CREATE INDEX entity_enrichment_legacy_coverage_idx ON public.entity_enrichment_queue
  (namespace,source_access_level,source_updated_at,memory_id)
  WHERE status='done' AND extraction_contract IS NULL;

-- Source changes always invalidate a prior coverage receipt.
CREATE OR REPLACE FUNCTION public.enqueue_memory_entity_enrichment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.access_level IS DISTINCT FROM OLD.access_level THEN
    INSERT INTO public.entity_enrichment_queue (
      memory_id, namespace, source_revision, source_updated_at, source_content_hash,
      source_access_level, status, attempts, next_attempt_at, locked_at,
      last_error_code, completed_at, extraction_contract, extraction_result, updated_at
    ) VALUES (
      NEW.id, NEW.namespace, NEW.entity_source_revision, COALESCE(NEW.updated_at, statement_timestamp()), md5(NEW.content),
      COALESCE(NEW.access_level, 'normal'), 'pending', 0, statement_timestamp(), NULL,
      NULL, NULL, NULL, NULL, statement_timestamp()
    )
    ON CONFLICT (memory_id) DO UPDATE SET
      namespace = EXCLUDED.namespace,
      source_revision = EXCLUDED.source_revision,
      source_updated_at = EXCLUDED.source_updated_at,
      source_content_hash = EXCLUDED.source_content_hash,
      source_access_level = EXCLUDED.source_access_level,
      status = 'pending', attempts = 0, next_attempt_at = statement_timestamp(),
      locked_at = NULL, last_error_code = NULL, completed_at = NULL,
      extraction_contract = NULL, extraction_result = NULL,
      updated_at = statement_timestamp();
  END IF;
  RETURN NEW;
END $$;

-- Marker columns are writable only through the fixed-shape completion function.
REVOKE UPDATE ON public.entity_enrichment_queue FROM total_recall_app;
GRANT UPDATE (
  namespace, source_revision, source_updated_at, source_content_hash, source_access_level,
  status, attempts, next_attempt_at, locked_at, last_error_code, completed_at, updated_at
) ON public.entity_enrichment_queue TO total_recall_app;

CREATE OR REPLACE FUNCTION public.complete_entity_enrichment_job(
  p_memory_id uuid,p_namespace text,p_source_revision integer,p_source_content_hash text,p_result text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF p_result NOT IN ('entities','empty') THEN
    RAISE EXCEPTION 'invalid entity extraction completion result' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.entity_enrichment_queue q
    JOIN public.memories m ON m.id=q.memory_id AND m.namespace=q.namespace
    WHERE q.memory_id=p_memory_id AND q.namespace=p_namespace AND q.status='processing'
      AND q.source_revision=p_source_revision AND q.source_content_hash=p_source_content_hash
      AND m.entity_source_revision=q.source_revision AND md5(m.content)=q.source_content_hash
      AND m.access_level=q.source_access_level AND m.memory_kind<>'episode_chunk'
      AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
      AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
      AND m.consolidated_into_id IS NULL
      AND public.app_entity_extract_scope_allowed(q.namespace,q.source_access_level)
      AND ((p_result='entities' AND EXISTS (SELECT 1 FROM public.memory_entities me
            WHERE me.memory_id=q.memory_id AND me.namespace=q.namespace))
        OR (p_result='empty' AND NOT EXISTS (SELECT 1 FROM public.memory_entities me
            WHERE me.memory_id=q.memory_id AND me.namespace=q.namespace)))
  ) THEN RETURN false; END IF;
  UPDATE public.entity_enrichment_queue SET status='done',locked_at=NULL,
    completed_at=statement_timestamp(),last_error_code=NULL,
    extraction_contract='entity-extraction:v1',extraction_result=p_result,
    updated_at=statement_timestamp()
  WHERE memory_id=p_memory_id AND namespace=p_namespace AND status='processing'
    AND source_revision=p_source_revision AND source_content_hash=p_source_content_hash;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;
REVOKE ALL ON FUNCTION public.complete_entity_enrichment_job(uuid,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_entity_enrichment_job(uuid,text,integer,text,text) TO total_recall_app;
