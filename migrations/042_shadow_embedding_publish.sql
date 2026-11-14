-- App-callable, ownership-checked publication of already-computed target vectors.
-- The application never receives direct write privileges on derived embedding tables.
CREATE FUNCTION public.publish_local_memory_embedding(
  p_parent UUID, p_contract TEXT, p_source_sha TEXT, p_chunks JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  qwen CONSTANT TEXT := '4340ee2917358817a4fe69234f137eb29580dd799266b783725f13c5a66d5f9e';
  parent public.memories%ROWTYPE;
  source_bytes BYTEA;
  item RECORD;
  item_count INTEGER;
  total_tokens BIGINT;
BEGIN
  IF p_contract IS DISTINCT FROM qwen OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=qwen
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
  VALUES(qwen,p_parent,p_source_sha,parent.revision,octet_length(source_bytes),item_count,total_tokens,false)
  ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
    source_revision=EXCLUDED.source_revision,source_bytes=EXCLUDED.source_bytes,
    chunk_count=EXCLUDED.chunk_count,total_tokens=EXCLUDED.total_tokens,is_current=false,
    committed_at=statement_timestamp();
  DELETE FROM public.memory_embedding_chunks WHERE contract_id=qwen AND parent_id=p_parent;
  INSERT INTO public.memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,
    chunk_sha256,formatted_tokens,embedding)
  SELECT qwen,p_parent,x.ordinal,x.core_start,x.core_end,x.sha256,x.tokens,x.vector::vector
  FROM jsonb_to_recordset(p_chunks) AS x(
    ordinal INTEGER, core_start INTEGER, core_end INTEGER, sha256 TEXT, tokens INTEGER, vector TEXT
  );
  UPDATE public.memory_embedding_manifests SET is_current=true,committed_at=statement_timestamp()
  WHERE contract_id=qwen AND parent_id=p_parent;
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id,state,generation,attempts,
    next_attempt_at,source_sha256,source_revision,updated_at)
  VALUES(qwen,'memory',p_parent,'complete',1,0,statement_timestamp(),p_source_sha,parent.revision,statement_timestamp())
  ON CONFLICT(contract_id,parent_type,parent_id) DO UPDATE SET state='complete',
    generation=embedding_work_items.generation+1,claimed_by=NULL,lease_until=NULL,attempts=0,
    next_attempt_at=statement_timestamp(),source_sha256=EXCLUDED.source_sha256,
    source_revision=EXCLUDED.source_revision,error_code=NULL,updated_at=statement_timestamp();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publish_local_memory_embedding(UUID,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_memory_embedding(UUID,TEXT,TEXT,JSONB) TO total_recall_app;

CREATE FUNCTION public.publish_local_subscription_embedding(
  p_subscription UUID, p_contract TEXT, p_source_sha TEXT, p_tokens INTEGER, p_vector TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  qwen CONSTANT TEXT := '4340ee2917358817a4fe69234f137eb29580dd799266b783725f13c5a66d5f9e';
  subscription public.memory_subscriptions%ROWTYPE;
BEGIN
  IF p_contract IS DISTINCT FROM qwen OR p_source_sha !~ '^[a-f0-9]{64}$'
    OR p_tokens IS NULL OR p_tokens<0 OR p_tokens>2000 OR p_vector IS NULL THEN
    RAISE EXCEPTION 'embedding.publish_shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_serving_settings s
    JOIN public.embedding_contracts c ON c.id=s.contract_id AND c.capture_enabled
    WHERE s.singleton AND s.contract_id=qwen
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
  VALUES(qwen,p_subscription,p_source_sha,p_tokens,p_vector::vector)
  ON CONFLICT(contract_id,subscription_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
    formatted_tokens=EXCLUDED.formatted_tokens,embedding=EXCLUDED.embedding,committed_at=statement_timestamp();
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id,state,generation,attempts,
    next_attempt_at,source_sha256,source_revision,updated_at)
  VALUES(qwen,'subscription',p_subscription,'complete',1,0,statement_timestamp(),p_source_sha,0,statement_timestamp())
  ON CONFLICT(contract_id,parent_type,parent_id) DO UPDATE SET state='complete',
    generation=embedding_work_items.generation+1,claimed_by=NULL,lease_until=NULL,attempts=0,
    next_attempt_at=statement_timestamp(),source_sha256=EXCLUDED.source_sha256,
    source_revision=0,error_code=NULL,updated_at=statement_timestamp();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publish_local_subscription_embedding(UUID,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_local_subscription_embedding(UUID,TEXT,TEXT,INTEGER,TEXT) TO total_recall_app;
