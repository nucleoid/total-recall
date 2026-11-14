-- #161: preserve transcript exclusions on the local target subscription path.
-- Function replacement retains both subscription trigger kill-switch states.
-- No backfill, vector rewrite, or applied migration changes.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.capture_shadow_subscription_insert_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.memory_kind = 'episode_chunk' THEN RETURN NEW; END IF;
  INSERT INTO public.shadow_subscription_insert_events(memory_id,contract_id,source_revision,inserted_at)
  SELECT NEW.id,s.contract_id,NEW.revision,clock_timestamp()
  FROM public.embedding_serving_settings s WHERE s.singleton
  ON CONFLICT(memory_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_shadow_subscription_insert_event() FROM PUBLIC,total_recall_app;

-- The parent guard also protects episode events captured before this migration.
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
  WHERE m.id=NEW.parent_id AND m.memory_kind <> 'episode_chunk' AND m.revision=NEW.source_revision
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
