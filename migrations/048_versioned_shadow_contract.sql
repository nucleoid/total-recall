-- Generalize the shadow-serving functions for the versioned contract selected in embedding_serving_settings.
-- Existing 0.6B rows remain immutable under their original contract; this only removes code-level ID pinning.

-- App-callable, ownership-checked publication of already-computed target vectors.
-- The application never receives direct write privileges on derived embedding tables.
CREATE OR REPLACE FUNCTION public.publish_local_memory_embedding(
  p_parent UUID, p_contract TEXT, p_source_sha TEXT, p_chunks JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE

  parent public.memories%ROWTYPE;
  source_bytes BYTEA;
  item RECORD;
  item_count INTEGER;
  total_tokens BIGINT;
BEGIN
  IF p_contract IS NULL OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=p_contract
  ) THEN RAISE EXCEPTION 'embedding.publish_contract'; END IF;

  SELECT m.* INTO parent FROM public.memories m
  JOIN public.api_keys k ON k.id::text=m.client_id
  WHERE m.id=p_parent AND k.id::text=public.app_current_key_id()
    AND k.enabled AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
    AND 'write'=ANY(k.permissions)
    AND m.namespace=ANY(k.namespaces) AND m.namespace=ANY(public.app_allowed_namespaces())
    AND CASE COALESCE(m.access_level,'normal') WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
      <= CASE k.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
    AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
    AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
  FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'embedding.publish_unauthorized'; END IF;

  source_bytes := convert_to(parent.content,'UTF8');
  IF octet_length(source_bytes)>1048576 THEN RAISE EXCEPTION 'embedding.parent_byte_limit'; END IF;
  IF encode(digest(source_bytes,'sha256'),'hex') IS DISTINCT FROM p_source_sha THEN RETURN false; END IF;

  SELECT count(*)::integer, COALESCE(sum(x.tokens),0)
  INTO item_count,total_tokens
  FROM jsonb_to_recordset(p_chunks) AS x(
    ordinal INTEGER, core_start INTEGER, core_end INTEGER, sha256 TEXT, tokens INTEGER, vector TEXT
  );
  IF item_count<1 OR item_count>4096 THEN RAISE EXCEPTION 'embedding.publish_chunk_count'; END IF;

  FOR item IN
    SELECT x.*,lag(x.core_end) OVER (ORDER BY x.ordinal) AS prior_end
    FROM jsonb_to_recordset(p_chunks) AS x(
      ordinal INTEGER, core_start INTEGER, core_end INTEGER, sha256 TEXT, tokens INTEGER, vector TEXT
    ) ORDER BY x.ordinal
  LOOP
    IF item.ordinal IS NULL OR item.ordinal<0 OR item.ordinal>=item_count
      OR item.core_start IS NULL OR item.core_end IS NULL OR item.core_start<0 OR item.core_end<item.core_start
      OR item.tokens IS NULL OR item.tokens<0 OR item.tokens>256
      OR item.sha256 IS NULL OR item.sha256 !~ '^[a-f0-9]{64}$' OR item.vector IS NULL
      OR (item.ordinal=0 AND item.core_start<>0)
      OR (item.ordinal>0 AND (item.prior_end IS NULL OR item.core_start<>item.prior_end))
      OR (item.ordinal=item_count-1 AND item.core_end<>octet_length(source_bytes)) THEN
      RAISE EXCEPTION 'embedding.publish_chunk_shape';
    END IF;
    -- convert_from rejects a boundary that bisects a UTF-8 code point.
    PERFORM convert_from(substring(source_bytes FROM item.core_start+1 FOR item.core_end-item.core_start),'UTF8');
    IF encode(digest(substring(source_bytes FROM item.core_start+1 FOR item.core_end-item.core_start),'sha256'),'hex')
      IS DISTINCT FROM item.sha256 THEN RAISE EXCEPTION 'embedding.publish_chunk_hash'; END IF;
    IF vector_dims(item.vector::vector)<>768 OR abs(vector_norm(item.vector::vector)-1)>=0.00001 THEN
      RAISE EXCEPTION 'embedding.publish_vector';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (x->>'ordinal')::integer) FROM jsonb_array_elements(p_chunks) x)<>item_count THEN
    RAISE EXCEPTION 'embedding.publish_chunk_order';
  END IF;

  INSERT INTO public.memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,
    source_bytes,chunk_count,total_tokens,is_current)
  VALUES(p_contract,p_parent,p_source_sha,parent.revision,octet_length(source_bytes),item_count,total_tokens,false)
  ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
    source_revision=EXCLUDED.source_revision,source_bytes=EXCLUDED.source_bytes,
    chunk_count=EXCLUDED.chunk_count,total_tokens=EXCLUDED.total_tokens,is_current=false,
    committed_at=statement_timestamp();
  DELETE FROM public.memory_embedding_chunks WHERE contract_id=p_contract AND parent_id=p_parent;
  INSERT INTO public.memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,
    chunk_sha256,formatted_tokens,embedding)
  SELECT p_contract,p_parent,x.ordinal,x.core_start,x.core_end,x.sha256,x.tokens,x.vector::vector
  FROM jsonb_to_recordset(p_chunks) AS x(
    ordinal INTEGER, core_start INTEGER, core_end INTEGER, sha256 TEXT, tokens INTEGER, vector TEXT
  );
  UPDATE public.memory_embedding_manifests SET is_current=true,committed_at=statement_timestamp()
  WHERE contract_id=p_contract AND parent_id=p_parent;
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id,state,generation,attempts,
    next_attempt_at,source_sha256,source_revision,updated_at)
  VALUES(p_contract,'memory',p_parent,'complete',1,0,statement_timestamp(),p_source_sha,parent.revision,statement_timestamp())
  ON CONFLICT(contract_id,parent_type,parent_id) DO UPDATE SET state='complete',
    generation=embedding_work_items.generation+1,claimed_by=NULL,lease_until=NULL,attempts=0,
    next_attempt_at=statement_timestamp(),source_sha256=EXCLUDED.source_sha256,
    source_revision=EXCLUDED.source_revision,error_code=NULL,updated_at=statement_timestamp();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publish_local_memory_embedding(UUID,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_memory_embedding(UUID,TEXT,TEXT,JSONB) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.publish_local_subscription_embedding(
  p_subscription UUID, p_contract TEXT, p_source_sha TEXT, p_tokens INTEGER, p_vector TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE

  subscription public.memory_subscriptions%ROWTYPE;
BEGIN
  IF p_contract IS NULL OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR p_tokens IS NULL OR p_tokens<0 OR p_tokens>2000 OR p_vector IS NULL THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=p_contract
  ) THEN RAISE EXCEPTION 'embedding.publish_contract'; END IF;
  SELECT s.* INTO subscription FROM public.memory_subscriptions s
  JOIN public.api_keys k ON k.id=s.api_key_id
  WHERE s.id=p_subscription AND k.id::text=public.app_current_key_id()
    AND k.enabled AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
    AND 'write'=ANY(k.permissions) AND s.status='active'
    AND CASE s.access_level_policy WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
      <= CASE k.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    AND EXISTS (SELECT 1 FROM public.subscription_namespaces sn
      WHERE sn.subscription_id=s.id AND sn.api_key_id=k.id
        AND sn.namespace=ANY(k.namespaces) AND sn.namespace=ANY(public.app_allowed_namespaces()))
  FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'embedding.publish_unauthorized'; END IF;
  IF encode(digest(subscription.query_text,'sha256'),'hex') IS DISTINCT FROM p_source_sha THEN RETURN false; END IF;
  IF vector_dims(p_vector::vector)<>768 OR abs(vector_norm(p_vector::vector)-1)>=0.00001 THEN
    RAISE EXCEPTION 'embedding.publish_vector';
  END IF;
  INSERT INTO public.subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding)
  VALUES(p_contract,p_subscription,p_source_sha,p_tokens,p_vector::vector)
  ON CONFLICT(contract_id,subscription_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
    formatted_tokens=EXCLUDED.formatted_tokens,embedding=EXCLUDED.embedding,committed_at=statement_timestamp();
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id,state,generation,attempts,
    next_attempt_at,source_sha256,source_revision,updated_at)
  VALUES(p_contract,'subscription',p_subscription,'complete',1,0,statement_timestamp(),p_source_sha,0,statement_timestamp())
  ON CONFLICT(contract_id,parent_type,parent_id) DO UPDATE SET state='complete',
    generation=embedding_work_items.generation+1,claimed_by=NULL,lease_until=NULL,attempts=0,
    next_attempt_at=statement_timestamp(),source_sha256=EXCLUDED.source_sha256,
    source_revision=0,error_code=NULL,updated_at=statement_timestamp();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publish_local_subscription_embedding(UUID,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_subscription_embedding(UUID,TEXT,TEXT,INTEGER,TEXT) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.guard_embedding_run_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$

BEGIN
  IF OLD.status='complete' AND NEW.status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'embedding.complete_run_immutable';
  END IF;
  IF OLD.completion_attestation IS NOT NULL AND NEW.completion_attestation IS DISTINCT FROM OLD.completion_attestation
    OR OLD.cutover_watermark IS NOT NULL AND NEW.cutover_watermark IS DISTINCT FROM OLD.cutover_watermark THEN
    RAISE EXCEPTION 'embedding.immutable_completion_attestation';
  END IF;
  IF NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    IF OLD.status<>'paused' OR NOT NEW.inventory_complete OR NEW.cutover_watermark IS NULL
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


CREATE OR REPLACE FUNCTION public.enqueue_shadow_subscription_webhooks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pending public.shadow_subscription_insert_events%ROWTYPE;
BEGIN
  IF NOT NEW.is_current THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.embedding_serving_settings s
    WHERE s.singleton AND s.contract_id=NEW.contract_id) THEN RETURN NEW; END IF;
  -- Serialize consumption. A prospective insert gets exactly one notification
  -- opportunity: its first complete manifest for the then-current live revision.
  SELECT * INTO pending FROM public.shadow_subscription_insert_events e
  WHERE e.memory_id=NEW.parent_id AND e.contract_id=NEW.contract_id AND e.processed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.memories m
  WHERE m.id=NEW.parent_id AND m.revision=NEW.source_revision
    AND NEW.source_sha256=encode(digest(m.content,'sha256'),'hex')
    AND (SELECT count(*) FROM public.memory_embedding_chunks c
         WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id)=NEW.chunk_count
    AND (SELECT min(c.ordinal)=0 AND max(c.ordinal)=NEW.chunk_count-1
         FROM public.memory_embedding_chunks c
         WHERE c.contract_id=NEW.contract_id AND c.parent_id=NEW.parent_id)
  FOR SHARE OF m;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- Do not consume while a subscription that existed at insert time and could
  -- receive this parent is still waiting for its current target vector.
  IF EXISTS (
    SELECT 1 FROM public.memories m
    JOIN public.memory_subscriptions s ON s.status='active' AND s.access_level_policy='normal'
    JOIN public.subscription_namespaces sn ON sn.subscription_id=s.id AND sn.api_key_id=s.api_key_id
      AND sn.namespace=m.namespace
    JOIN public.api_keys k ON k.id=s.api_key_id
    LEFT JOIN public.subscription_embedding_targets target ON target.contract_id=NEW.contract_id
      AND target.subscription_id=s.id AND target.source_sha256=encode(digest(s.query_text,'sha256'),'hex')
    WHERE m.id=NEW.parent_id AND COALESCE(m.access_level,'normal')='normal'
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
      AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
      AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
      AND k.enabled=true AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
      AND m.namespace=ANY(k.namespaces) AND (NOT s.exclude_self OR m.client_id<>s.api_key_id::text)
      AND s.created_at<pending.inserted_at AND target.subscription_id IS NULL
  ) THEN RETURN NEW; END IF;
  UPDATE public.shadow_subscription_insert_events
  SET processed_at=clock_timestamp(),processed_revision=NEW.source_revision
  WHERE memory_id=NEW.parent_id;
  WITH parent AS MATERIALIZED (
    SELECT m.id,m.namespace,m.client_id,e.event_version
    FROM public.memories m
    JOIN public.shadow_subscription_insert_events e ON e.memory_id=m.id AND e.contract_id=NEW.contract_id
    JOIN public.embedding_serving_settings serving ON serving.singleton AND serving.contract_id=NEW.contract_id
    WHERE m.id=NEW.parent_id AND e.processed_revision=NEW.source_revision AND m.revision=NEW.source_revision
      AND NEW.source_sha256=encode(digest(m.content,'sha256'),'hex')
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
      AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
      AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
      AND COALESCE(m.access_level,'normal')='normal'
  ), scored AS MATERIALIZED (
    SELECT s.id,s.api_key_id,p.id AS memory_id,p.namespace,p.event_version,
      max((1-(target.embedding <=> chunk.embedding))::double precision) AS similarity
    FROM parent p
    JOIN public.memory_subscriptions s ON s.status='active' AND s.access_level_policy='normal'
    JOIN public.subscription_namespaces sn ON sn.subscription_id=s.id AND sn.api_key_id=s.api_key_id
      AND sn.namespace=p.namespace
    JOIN public.api_keys k ON k.id=s.api_key_id
    JOIN public.subscription_embedding_targets target ON target.contract_id=NEW.contract_id
      AND target.subscription_id=s.id AND target.source_sha256=encode(digest(s.query_text,'sha256'),'hex')
    JOIN public.memory_embedding_chunks chunk ON chunk.contract_id=NEW.contract_id AND chunk.parent_id=p.id
    JOIN public.shadow_subscription_insert_events e ON e.memory_id=p.id
    WHERE k.enabled=true AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
      AND p.namespace=ANY(k.namespaces) AND COALESCE(k.max_access_level,'normal') IN ('normal','sensitive','secret')
      AND (NOT s.exclude_self OR p.client_id<>s.api_key_id::text) AND s.created_at<e.inserted_at
    GROUP BY s.id,s.api_key_id,p.id,p.namespace,p.event_version,s.threshold
    HAVING max((1-(target.embedding <=> chunk.embedding))::double precision)>=s.threshold
  ), matched AS MATERIALIZED (
    SELECT * FROM scored ORDER BY scored.similarity DESC,scored.id LIMIT 101
  ), enqueued AS (
    INSERT INTO public.webhook_deliveries(subscription_id,api_key_id,memory_id,namespace,event_version,similarity)
    SELECT matched.id,matched.api_key_id,matched.memory_id,matched.namespace,matched.event_version,matched.similarity
    FROM matched ORDER BY matched.similarity DESC,matched.id LIMIT 100
    ON CONFLICT(subscription_id,memory_id,event_version) DO NOTHING RETURNING 1
  )
  INSERT INTO public.subscription_match_truncations(memory_id,namespace)
  SELECT NEW.parent_id,p.namespace FROM parent p
  WHERE (SELECT count(*) FROM matched)>100 AND (SELECT count(*) FROM enqueued)>=0
  ON CONFLICT(memory_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_shadow_subscription_webhooks() FROM PUBLIC,total_recall_app;

CREATE OR REPLACE FUNCTION public.retry_shadow_subscription_events_for_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memory_subscriptions s WHERE s.id=NEW.subscription_id
      AND NEW.source_sha256=encode(digest(s.query_text,'sha256'),'hex')) THEN RETURN NEW; END IF;
  UPDATE public.memory_embedding_manifests manifest SET committed_at=manifest.committed_at
  WHERE (manifest.contract_id,manifest.parent_id) IN (
    SELECT manifest2.contract_id,manifest2.parent_id
    FROM public.shadow_subscription_insert_events event
    JOIN public.memories m ON m.id=event.memory_id
    JOIN public.memory_embedding_manifests manifest2 ON manifest2.contract_id=event.contract_id
      AND manifest2.parent_id=event.memory_id AND manifest2.is_current AND manifest2.source_revision=m.revision
    JOIN public.memory_subscriptions s ON s.id=NEW.subscription_id AND s.status='active'
      AND s.access_level_policy='normal' AND s.created_at<event.inserted_at
    JOIN public.subscription_namespaces sn ON sn.subscription_id=s.id AND sn.api_key_id=s.api_key_id
      AND sn.namespace=m.namespace
    WHERE event.contract_id=NEW.contract_id AND event.processed_at IS NULL
    ORDER BY event.inserted_at,event.memory_id LIMIT 100
  );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.retry_shadow_subscription_events_for_target() FROM PUBLIC,total_recall_app;
