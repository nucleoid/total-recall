-- #160: additive document chunk provenance; applied 049/050/051 remain immutable.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.memory_ingestion_jobs
  ADD COLUMN document_id UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  ADD COLUMN chunk_index INTEGER CHECK (chunk_index >= 0);
CREATE INDEX memory_ingestion_document_idx ON public.memory_ingestion_jobs (document_id, status)
  WHERE document_id IS NOT NULL;

-- Document chunks keep creation notifications; updates still suppress them.
CREATE OR REPLACE FUNCTION public.enqueue_memory_subscription_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.embedding_serving_settings WHERE singleton) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.memory_ingestion_jobs j
    WHERE j.memory_id = NEW.id AND j.kind NOT IN ('store','document')) THEN RETURN NEW; END IF;
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
    WHERE j.memory_id=NEW.parent_id AND j.kind NOT IN ('store','document')) THEN
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
