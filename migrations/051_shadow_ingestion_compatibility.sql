-- Unify legacy durable-ready and target-manifest subscription routing.
-- Existing applied migrations remain byte-identical. Trigger enablement is unchanged.
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.enqueue_memory_subscription_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.embedding_serving_settings WHERE singleton) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.memory_ingestion_jobs j
    WHERE j.memory_id = NEW.id AND j.kind <> 'store') THEN RETURN NEW; END IF;
  -- An UPDATE is a queued creation event only for a matching nonterminal queued job.
  -- Historical re-embedding and ordinary content updates must not create events.
  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM public.memory_ingestion_jobs j
    WHERE j.memory_id = NEW.id AND j.namespace = NEW.namespace AND j.creation_pending
      AND j.status IN ('pending','processing','retry_wait')
  ) THEN RETURN NEW; END IF;
  IF NEW.embedding IS NULL
     OR NEW.embedding_provider IS NULL
     OR NEW.embedding_model IS NULL
     OR NEW.embedding_dimensions IS NULL
     OR COALESCE(NEW.access_level, 'normal') <> 'normal' THEN
    RETURN NEW;
  END IF;

  -- Materialize at most 101 exact matches once. The first 100 become durable
  -- deliveries; the extra row records content-free truncation without a second
  -- cosine scan. Exact matching is intentional until measured volume justifies
  -- a separately reviewed approximate index.
  WITH matched AS MATERIALIZED (
    SELECT s.id, s.api_key_id, (1 - (s.query_embedding <=> NEW.embedding))::double precision AS similarity
    FROM public.memory_subscriptions s
    JOIN public.subscription_namespaces sn ON sn.subscription_id = s.id AND sn.api_key_id = s.api_key_id
    JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.status = 'active'
      AND s.access_level_policy = 'normal'
      AND sn.namespace = NEW.namespace
      AND k.enabled = true
      AND NEW.namespace = ANY(k.namespaces)
      AND (NOT s.exclude_self OR NEW.client_id <> s.api_key_id::text)
      AND s.embedding_provider = NEW.embedding_provider
      AND s.embedding_model = NEW.embedding_model
      AND s.embedding_dimensions = NEW.embedding_dimensions
      AND (1 - (s.query_embedding <=> NEW.embedding)) >= s.threshold
    ORDER BY similarity DESC, s.id
    LIMIT 101
  ), enqueued AS (
    INSERT INTO public.webhook_deliveries
      (subscription_id, api_key_id, memory_id, namespace, event_version, similarity)
    SELECT matched.id, matched.api_key_id, NEW.id, NEW.namespace, 1, matched.similarity
    FROM matched ORDER BY matched.similarity DESC, matched.id LIMIT 100
    ON CONFLICT (subscription_id, memory_id, event_version) DO NOTHING
    RETURNING 1
  )
  INSERT INTO public.subscription_match_truncations (memory_id, namespace)
  SELECT NEW.id, NEW.namespace
  WHERE (SELECT count(*) FROM matched) > 100
    AND (SELECT count(*) FROM enqueued) >= 0
  ON CONFLICT (memory_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_shadow_subscription_webhooks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pending public.shadow_subscription_insert_events%ROWTYPE;
BEGIN
  IF NOT NEW.is_current OR NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=NEW.contract_id
  ) THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.embedding_serving_settings s
    WHERE s.singleton AND s.contract_id=NEW.contract_id) THEN RETURN NEW; END IF;
  -- Serialize consumption. A prospective insert gets exactly one notification
  -- opportunity: its first complete manifest for the then-current live revision.
  SELECT * INTO pending FROM public.shadow_subscription_insert_events e
  WHERE e.memory_id=NEW.parent_id AND e.contract_id=NEW.contract_id AND e.processed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- Replacing a queued creation with a content update is not a new event.
  IF EXISTS (SELECT 1 FROM public.memory_ingestion_jobs j
    WHERE j.memory_id=NEW.parent_id AND j.kind<>'store') THEN
    UPDATE public.shadow_subscription_insert_events SET processed_at=clock_timestamp(),
      processed_revision=NEW.source_revision WHERE memory_id=NEW.parent_id;
    RETURN NEW;
  END IF;
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

CREATE FUNCTION public.publish_local_ingestion_embedding(
  p_parent UUID, p_contract TEXT, p_source_sha TEXT, p_chunks JSONB, p_lease UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent public.memories%ROWTYPE;
  source_bytes BYTEA;
  item RECORD;
  item_count INTEGER;
  total_tokens BIGINT;
BEGIN
  IF p_contract IS NULL OR p_contract !~ '^[a-f0-9]{64}$' OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=p_contract
  ) THEN RAISE EXCEPTION 'embedding.publish_contract'; END IF;

  PERFORM 1 FROM public.memory_ingestion_jobs j
  WHERE j.memory_id=p_parent AND j.client_id=public.app_current_key_id()
    AND j.namespace=ANY(public.app_allowed_namespaces()) AND j.status='processing'
    AND j.lease_token=p_lease AND j.lease_expires_at>statement_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'embedding.publish_unauthorized'; END IF;

  -- The durable job is the single-row acceptance authority. Revocation blocks
  -- new/cross-row mutations, not completion of already committed content.
  SELECT m.* INTO parent FROM public.memories m
  JOIN public.memory_ingestion_jobs j ON j.memory_id=m.id AND j.namespace=m.namespace
  WHERE m.id=p_parent AND j.client_id=public.app_current_key_id()
    AND j.namespace=ANY(public.app_allowed_namespaces())
    AND j.status='processing' AND j.lease_token=p_lease AND j.lease_expires_at>statement_timestamp()
    AND COALESCE(m.access_level,'normal')=j.access_level
    AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
    AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
    AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
  FOR UPDATE OF j,m;
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
REVOKE ALL ON FUNCTION public.publish_local_ingestion_embedding(UUID,TEXT,TEXT,JSONB,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_ingestion_embedding(UUID,TEXT,TEXT,JSONB,UUID) TO total_recall_app;


-- Authorized namespace editors may update another creator's memory. The original
-- store publication helper retains its creator-only authority unchanged.
CREATE FUNCTION public.publish_local_memory_update_embedding(
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
  IF p_contract IS NULL OR p_contract !~ '^[a-f0-9]{64}$' OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=p_contract
  ) THEN RAISE EXCEPTION 'embedding.publish_contract'; END IF;

  SELECT m.* INTO parent FROM public.memories m
  JOIN public.api_keys k ON k.id::text=public.app_current_key_id()
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
REVOKE ALL ON FUNCTION public.publish_local_memory_update_embedding(UUID,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_memory_update_embedding(UUID,TEXT,TEXT,JSONB) TO total_recall_app;
