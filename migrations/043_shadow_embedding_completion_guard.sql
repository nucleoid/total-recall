-- Completion is an operator attestation backed by independently inspectable state.
ALTER TABLE public.embedding_runs
  ADD COLUMN completion_attestation JSONB,
  ADD COLUMN cutover_watermark TIMESTAMPTZ;

CREATE FUNCTION public.guard_embedding_run_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE qwen CONSTANT TEXT := '4340ee2917358817a4fe69234f137eb29580dd799266b783725f13c5a66d5f9e';
BEGIN
  IF OLD.status='complete' AND NEW.status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'embedding.complete_run_immutable';
  END IF;
  IF OLD.completion_attestation IS NOT NULL AND NEW.completion_attestation IS DISTINCT FROM OLD.completion_attestation
    OR OLD.cutover_watermark IS NOT NULL AND NEW.cutover_watermark IS DISTINCT FROM OLD.cutover_watermark THEN
    RAISE EXCEPTION 'embedding.immutable_completion_attestation';
  END IF;
  IF NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    IF OLD.status<>'paused' OR NEW.contract_id<>qwen OR NOT NEW.inventory_complete OR NEW.cutover_watermark IS NULL
      OR NEW.cutover_watermark>statement_timestamp()
      OR NEW.completion_attestation IS NULL OR jsonb_typeof(NEW.completion_attestation)<>'object'
      OR NOT (NEW.completion_attestation ?& ARRAY['qualityReceiptSha256','auditReceiptSha256','backupReceiptSha256','cutoverApprovalSha256'])
      OR EXISTS (SELECT 1 FROM jsonb_each_text(NEW.completion_attestation) a
        WHERE a.key IN ('qualityReceiptSha256','auditReceiptSha256','backupReceiptSha256','cutoverApprovalSha256')
          AND a.value !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'embedding.completion_attestation'; END IF;
    IF EXISTS (SELECT 1 FROM public.embedding_work_items w WHERE w.contract_id=NEW.contract_id
      AND w.state IN ('pending','claimed','retry') AND NOT (w.state='retry' AND w.error_code='embedding.valid_from_deferred'))
      OR EXISTS (SELECT 1 FROM public.embedding_work_items w WHERE w.contract_id=NEW.contract_id AND w.state='failed')
      OR EXISTS (SELECT 1 FROM public.memories m LEFT JOIN public.memory_embedding_manifests f
        ON f.contract_id=NEW.contract_id AND f.parent_id=m.id
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
          AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
          AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
          AND (f.parent_id IS NULL OR NOT f.is_current OR f.source_revision<>m.revision
            OR f.source_sha256<>encode(digest(m.content,'sha256'),'hex')
            OR (SELECT count(*) FROM public.memory_embedding_chunks c
                WHERE c.contract_id=NEW.contract_id AND c.parent_id=m.id)<>f.chunk_count))
      OR EXISTS (SELECT 1 FROM public.memory_subscriptions s LEFT JOIN public.subscription_embedding_targets t
        ON t.contract_id=NEW.contract_id AND t.subscription_id=s.id
        WHERE s.status='active' AND (t.subscription_id IS NULL
          OR t.source_sha256<>encode(digest(s.query_text,'sha256'),'hex') OR vector_dims(t.embedding)<>768
          OR abs(vector_norm(t.embedding)-1)>=0.00001 OR t.formatted_tokens NOT BETWEEN 0 AND 2000))
      OR EXISTS (SELECT 1 FROM public.shadow_subscription_insert_events e JOIN public.memories m ON m.id=e.memory_id
        WHERE e.contract_id=NEW.contract_id AND e.processed_at IS NULL AND COALESCE(m.access_level,'normal')='normal'
          AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
          AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
          AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())) THEN
      RAISE EXCEPTION 'embedding.completion_not_drained';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.embedding_serving_settings s JOIN public.embedding_contracts c
      ON c.id=s.contract_id AND c.capture_enabled WHERE s.singleton AND s.contract_id=NEW.contract_id
        AND s.observation_ends_at IS NOT NULL AND s.observation_ends_at<=statement_timestamp()) THEN
      RAISE EXCEPTION 'embedding.observation_not_complete';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      JOIN pg_catalog.pg_class p ON p.oid=i.indrelid JOIN pg_catalog.pg_inherits h ON h.inhrelid=p.oid
      WHERE h.inhparent='public.memory_embedding_chunks'::regclass AND i.indisvalid AND i.indisready
        AND pg_catalog.pg_get_expr(p.relpartbound,p.oid) LIKE '%'||NEW.contract_id||'%'
        AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%USING hnsw%'
        AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%vector_cosine_ops%') THEN
      RAISE EXCEPTION 'embedding.index_not_ready';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_run_completion_guard BEFORE UPDATE ON public.embedding_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_run_completion();
