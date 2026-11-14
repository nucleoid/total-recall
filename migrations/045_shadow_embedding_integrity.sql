-- Durable cutover proof and cheap online completeness checks. Expensive hashes and
-- chunk census validation happen at publication/attestation, never per search.
CREATE TABLE public.embedding_cutover_attestations (
  run_id UUID PRIMARY KEY REFERENCES public.embedding_runs(id),
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  watermark TIMESTAMPTZ NOT NULL,
  memory_census BIGINT NOT NULL CHECK(memory_census>=0),
  subscription_census BIGINT NOT NULL CHECK(subscription_census>=0),
  audit_receipt_sha256 TEXT NOT NULL CHECK(audit_receipt_sha256~'^[a-f0-9]{64}$'),
  quality_receipt_sha256 TEXT NOT NULL CHECK(quality_receipt_sha256~'^[a-f0-9]{64}$'),
  backup_receipt_sha256 TEXT NOT NULL CHECK(backup_receipt_sha256~'^[a-f0-9]{64}$'),
  approval_sha256 TEXT NOT NULL CHECK(approval_sha256~'^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(contract_id,run_id)
);
REVOKE ALL ON public.embedding_cutover_attestations FROM PUBLIC,total_recall_app;

CREATE FUNCTION public.guard_embedding_cutover_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'embedding.cutover_attestation_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.embedding_runs r WHERE r.id=NEW.run_id AND r.contract_id=NEW.contract_id
      AND r.status='paused' AND r.inventory_complete AND r.source_watermark<=NEW.watermark
      AND NEW.watermark<=statement_timestamp() AND (r.completion_attestation IS NULL OR
        r.completion_attestation->>'qualityReceiptSha256'=NEW.quality_receipt_sha256 AND r.completion_attestation->>'auditReceiptSha256'=NEW.audit_receipt_sha256
        AND r.completion_attestation->>'backupReceiptSha256'=NEW.backup_receipt_sha256 AND r.completion_attestation->>'cutoverApprovalSha256'=NEW.approval_sha256))
    OR NOT EXISTS(SELECT 1 FROM public.embedding_contracts c WHERE c.id=NEW.contract_id AND c.capture_enabled)
    OR EXISTS(SELECT 1 FROM public.embedding_work_items w WHERE w.contract_id=NEW.contract_id
      AND (w.state IN('pending','claimed','failed') OR (w.state='retry' AND (w.error_code IS DISTINCT FROM 'embedding.valid_from_deferred'
        OR w.next_attempt_at<=statement_timestamp() OR NOT EXISTS(SELECT 1 FROM public.memories m WHERE m.id=w.parent_id AND m.valid_from>statement_timestamp() AND w.next_attempt_at>=m.valid_from)))))
    OR NEW.memory_census<>(SELECT count(*) FROM public.memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()))
    OR EXISTS(SELECT 1 FROM public.memories m LEFT JOIN public.memory_embedding_manifests f ON f.contract_id=NEW.contract_id AND f.parent_id=m.id
      WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
        AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
        AND (f.parent_id IS NULL OR NOT f.is_current OR f.source_revision<>m.revision OR f.source_sha256<>encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
          OR f.source_bytes<>octet_length(convert_to(m.content,'UTF8')) OR f.chunk_count<>(SELECT count(*) FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=m.id)
          OR f.total_tokens<>(SELECT COALESCE(sum(c.formatted_tokens),0) FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=m.id)
          OR NOT COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=f.chunk_count-1 FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=m.id),false)))
    OR EXISTS(SELECT 1 FROM public.memories m JOIN public.memory_embedding_manifests f ON f.contract_id=NEW.contract_id AND f.parent_id=m.id
      JOIN (SELECT c.*,lag(c.core_end) OVER(PARTITION BY c.parent_id ORDER BY c.ordinal) prior_end FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id) c ON c.parent_id=m.id
      WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
        AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
        AND ((c.ordinal=0 AND c.core_start<>0) OR (c.ordinal>0 AND c.core_start IS DISTINCT FROM c.prior_end) OR (c.ordinal=f.chunk_count-1 AND c.core_end<>f.source_bytes)
          OR convert_to(convert_from(substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start),'UTF8'),'UTF8')<>substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start)
          OR c.chunk_sha256<>encode(digest(substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start),'sha256'),'hex')))
    OR NEW.subscription_census<>(SELECT count(*) FROM public.memory_subscriptions s JOIN public.api_keys k ON k.id=s.api_key_id
      WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp()))
    OR EXISTS(SELECT 1 FROM public.memory_subscriptions s JOIN public.api_keys k ON k.id=s.api_key_id
      LEFT JOIN public.subscription_embedding_targets t ON t.contract_id=NEW.contract_id AND t.subscription_id=s.id
      WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
        AND (t.subscription_id IS NULL OR t.source_sha256<>encode(digest(convert_to(s.query_text,'UTF8'),'sha256'),'hex')
        OR t.formatted_tokens NOT BETWEEN 0 AND 2000 OR vector_dims(t.embedding)<>768 OR abs(vector_norm(t.embedding)-1)>=0.00001))
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      JOIN pg_catalog.pg_class p ON p.oid=i.indrelid JOIN pg_catalog.pg_inherits h ON h.inhrelid=p.oid
      WHERE h.inhparent='public.memory_embedding_chunks'::regclass AND i.indisvalid AND i.indisready
        AND pg_catalog.pg_get_expr(p.relpartbound,p.oid) LIKE '%'||NEW.contract_id||'%'
        AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%USING hnsw%'
        AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%vector_cosine_ops%') THEN
    RAISE EXCEPTION 'embedding.cutover_attestation_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_cutover_attestation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.embedding_cutover_attestations
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_cutover_attestation();

CREATE FUNCTION public.guard_embedding_completion_cutover_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete' AND NOT EXISTS(
    SELECT 1 FROM public.embedding_cutover_attestations a WHERE a.run_id=NEW.id AND a.contract_id=NEW.contract_id
      AND NEW.cutover_watermark=a.watermark
      AND NEW.completion_attestation->>'qualityReceiptSha256'=a.quality_receipt_sha256
      AND NEW.completion_attestation->>'auditReceiptSha256'=a.audit_receipt_sha256
      AND NEW.completion_attestation->>'backupReceiptSha256'=a.backup_receipt_sha256
      AND NEW.completion_attestation->>'cutoverApprovalSha256'=a.approval_sha256
  ) THEN RAISE EXCEPTION 'embedding.completion_cutover_mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_run_cutover_receipt_guard BEFORE UPDATE ON public.embedding_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_completion_cutover_receipt();

DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.embedding_serving_settings) THEN RAISE EXCEPTION 'embedding.unattested_serving_upgrade'; END IF; END $$;
ALTER TABLE public.embedding_serving_settings ADD COLUMN cutover_attestation_run_id UUID NOT NULL;
ALTER TABLE public.embedding_serving_settings ADD CONSTRAINT embedding_serving_cutover_attestation_fk
  FOREIGN KEY(contract_id,cutover_attestation_run_id)
  REFERENCES public.embedding_cutover_attestations(contract_id,run_id);

CREATE FUNCTION public.validate_current_embedding_manifest() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.contract_id,NEW.parent_id) IS DISTINCT FROM (OLD.contract_id,OLD.parent_id) THEN RAISE EXCEPTION 'embedding.manifest_identity_immutable'; END IF;
  IF NEW.is_current AND (TG_OP='INSERT' OR NOT OLD.is_current) THEN
    IF NOT EXISTS(SELECT 1 FROM public.memories m WHERE m.id=NEW.parent_id AND m.revision=NEW.source_revision
        AND NEW.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
        AND NEW.source_bytes=octet_length(convert_to(m.content,'UTF8')))
      OR (SELECT count(*) FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id)<>NEW.chunk_count
      OR NOT COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=NEW.chunk_count-1
        FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id),false)
      OR (SELECT COALESCE(sum(c.formatted_tokens),0) FROM public.memory_embedding_chunks c
        WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id)<>NEW.total_tokens
      OR EXISTS(SELECT 1 FROM public.memories m JOIN (
          SELECT c.*,lag(c.core_end) OVER(ORDER BY c.ordinal) prior_end
          FROM public.memory_embedding_chunks c WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id
        ) c ON true WHERE m.id=NEW.parent_id AND (c.core_start<0 OR c.core_end<c.core_start
          OR (c.ordinal=0 AND c.core_start<>0) OR (c.ordinal>0 AND c.core_start IS DISTINCT FROM c.prior_end)
          OR (c.ordinal=NEW.chunk_count-1 AND c.core_end<>NEW.source_bytes)
          OR convert_to(convert_from(substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start),'UTF8'),'UTF8')
            <>substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start)
          OR c.chunk_sha256<>encode(digest(substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start),'sha256'),'hex'))) THEN
      RAISE EXCEPTION 'embedding.current_manifest_invalid';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.is_current AND NEW.is_current AND
    (NEW.source_sha256,NEW.source_revision,NEW.source_bytes,NEW.chunk_count,NEW.total_tokens)
      IS DISTINCT FROM (OLD.source_sha256,OLD.source_revision,OLD.source_bytes,OLD.chunk_count,OLD.total_tokens) THEN
    RAISE EXCEPTION 'embedding.current_manifest_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_current_embedding_manifest BEFORE INSERT OR UPDATE ON public.memory_embedding_manifests
FOR EACH ROW EXECUTE FUNCTION public.validate_current_embedding_manifest();

CREATE FUNCTION public.enqueue_invalidated_embedding_manifest() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE contract TEXT:=COALESCE(NEW.contract_id,OLD.contract_id); parent UUID:=COALESCE(NEW.parent_id,OLD.parent_id);
BEGIN
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id,state,generation,attempts,next_attempt_at,updated_at)
  SELECT contract,'memory',parent,'pending',1,0,statement_timestamp(),statement_timestamp()
  WHERE EXISTS(SELECT 1 FROM public.memories WHERE id=parent)
  ON CONFLICT(contract_id,parent_type,parent_id) DO UPDATE SET state='pending',generation=embedding_work_items.generation+1,
    claimed_by=NULL,lease_until=NULL,attempts=0,next_attempt_at=statement_timestamp(),source_sha256=NULL,
    source_revision=NULL,error_code=NULL,updated_at=statement_timestamp()
    WHERE NOT(embedding_work_items.state='claimed' AND embedding_work_items.lease_until>statement_timestamp());
  RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_invalidated_embedding_manifest() FROM PUBLIC,total_recall_app;
CREATE TRIGGER enqueue_invalidated_manifest AFTER UPDATE OF is_current ON public.memory_embedding_manifests
FOR EACH ROW WHEN(OLD.is_current AND NOT NEW.is_current) EXECUTE FUNCTION public.enqueue_invalidated_embedding_manifest();
CREATE TRIGGER enqueue_deleted_manifest AFTER DELETE ON public.memory_embedding_manifests
FOR EACH ROW EXECUTE FUNCTION public.enqueue_invalidated_embedding_manifest();

CREATE FUNCTION public.invalidate_manifest_for_chunk_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP IN('UPDATE','DELETE') THEN UPDATE public.memory_embedding_manifests SET is_current=false
    WHERE contract_id=OLD.contract_id AND parent_id=OLD.parent_id AND is_current; END IF;
  IF TG_OP IN('UPDATE','INSERT') THEN UPDATE public.memory_embedding_manifests SET is_current=false
    WHERE contract_id=NEW.contract_id AND parent_id=NEW.parent_id AND is_current; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION public.invalidate_manifest_for_chunk_mutation() FROM PUBLIC,total_recall_app;
CREATE TRIGGER invalidate_manifest_for_chunk_insert AFTER INSERT ON public.memory_embedding_chunks
FOR EACH ROW EXECUTE FUNCTION public.invalidate_manifest_for_chunk_mutation();
CREATE TRIGGER invalidate_manifest_for_chunk_update AFTER UPDATE ON public.memory_embedding_chunks
FOR EACH ROW EXECUTE FUNCTION public.invalidate_manifest_for_chunk_mutation();
CREATE TRIGGER invalidate_manifest_for_chunk_delete AFTER DELETE ON public.memory_embedding_chunks
FOR EACH ROW EXECUTE FUNCTION public.invalidate_manifest_for_chunk_mutation();

CREATE INDEX embedding_work_incomplete_scope_idx ON public.embedding_work_items(contract_id,parent_type,parent_id)
WHERE state<>'complete';

CREATE FUNCTION public.shadow_embedding_scope_ready(requested_namespaces TEXT[],requested_access TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE key public.api_keys%ROWTYPE; allowed TEXT[]; ceiling INTEGER; requested INTEGER;
BEGIN
  SELECT * INTO key FROM public.api_keys k WHERE k.id=public.app_current_key_id()::uuid AND k.enabled AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp()) AND 'read'=ANY(k.permissions);
  IF NOT FOUND OR requested_namespaces IS NULL OR cardinality(requested_namespaces)=0 THEN RETURN false; END IF;
  allowed:=public.app_allowed_namespaces();
  IF EXISTS(SELECT 1 FROM unnest(requested_namespaces) n WHERE NOT(n=ANY(key.namespaces) AND n=ANY(allowed))) THEN RETURN false; END IF;
  ceiling:=CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END;
  requested:=CASE requested_access WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END;
  IF requested>ceiling THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.embedding_serving_settings s JOIN public.embedding_cutover_attestations a
    ON a.run_id=s.cutover_attestation_run_id AND a.contract_id=s.contract_id WHERE s.singleton) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.embedding_serving_settings s JOIN pg_catalog.pg_index i ON true
    JOIN pg_catalog.pg_class p ON p.oid=i.indrelid JOIN pg_catalog.pg_inherits h ON h.inhrelid=p.oid
    WHERE s.singleton AND h.inhparent='public.memory_embedding_chunks'::regclass AND i.indisvalid AND i.indisready
      AND pg_catalog.pg_get_expr(p.relpartbound,p.oid) LIKE '%'||s.contract_id||'%'
      AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%USING hnsw%'
      AND pg_catalog.pg_get_indexdef(i.indexrelid) LIKE '%vector_cosine_ops%') THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_work_items w ON w.contract_id=s.contract_id AND w.parent_type='memory' AND w.state<>'complete'
    JOIN public.memories m ON m.id=w.parent_id
    WHERE s.singleton AND m.namespace=ANY(requested_namespaces)
      AND CASE COALESCE(m.access_level,'normal') WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END<=requested
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
      AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()));
END $$;
REVOKE ALL ON FUNCTION public.shadow_embedding_scope_ready(TEXT[],TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shadow_embedding_scope_ready(TEXT[],TEXT) TO total_recall_app;
