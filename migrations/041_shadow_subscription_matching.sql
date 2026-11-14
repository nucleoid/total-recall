-- Prospective target-space subscription events. This ledger is deliberately
-- content-free and operator-only; it proves a memory was inserted after cutover.
CREATE TABLE public.shadow_subscription_insert_events (
  memory_id UUID PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  source_revision INTEGER NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  inserted_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  processed_revision INTEGER,
  CHECK ((processed_at IS NULL) = (processed_revision IS NULL))
);
REVOKE ALL ON public.shadow_subscription_insert_events FROM PUBLIC,total_recall_app;

CREATE FUNCTION public.capture_shadow_subscription_insert_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.shadow_subscription_insert_events(memory_id,contract_id,source_revision,inserted_at)
  SELECT NEW.id,s.contract_id,NEW.revision,clock_timestamp()
  FROM public.embedding_serving_settings s WHERE s.singleton
  ON CONFLICT(memory_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_shadow_subscription_insert_event() FROM PUBLIC,total_recall_app;
CREATE TRIGGER memories_shadow_subscription_event
AFTER INSERT ON public.memories FOR EACH ROW EXECUTE FUNCTION public.capture_shadow_subscription_insert_event();

-- Preserve migration 029's Gemini behavior until a target serving row exists.
-- Once target serving is active, the INSERT trigger only records the event above;
-- matching waits for an atomic complete target manifest.
CREATE OR REPLACE FUNCTION public.enqueue_memory_subscription_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.embedding_serving_settings WHERE singleton) THEN RETURN NEW; END IF;
  IF NEW.embedding IS NULL
     OR NEW.embedding_provider IS NULL
     OR NEW.embedding_model IS NULL
     OR NEW.embedding_dimensions IS NULL
     OR COALESCE(NEW.access_level, 'normal') <> 'normal' THEN
    RETURN NEW;
  END IF;
  WITH matched AS MATERIALIZED (
    SELECT s.id, s.api_key_id, (1 - (s.query_embedding <=> NEW.embedding))::double precision AS similarity
    FROM public.memory_subscriptions s
    JOIN public.subscription_namespaces sn ON sn.subscription_id = s.id AND sn.api_key_id = s.api_key_id
    JOIN public.api_keys k ON k.id = s.api_key_id
    WHERE s.status = 'active' AND s.access_level_policy = 'normal' AND sn.namespace = NEW.namespace
      AND k.enabled = true AND NEW.namespace = ANY(k.namespaces)
      AND (NOT s.exclude_self OR NEW.client_id <> s.api_key_id::text)
      AND s.embedding_provider = NEW.embedding_provider AND s.embedding_model = NEW.embedding_model
      AND s.embedding_dimensions = NEW.embedding_dimensions
      AND (1 - (s.query_embedding <=> NEW.embedding)) >= s.threshold
    ORDER BY similarity DESC, s.id LIMIT 101
  ), enqueued AS (
    INSERT INTO public.webhook_deliveries(subscription_id,api_key_id,memory_id,namespace,event_version,similarity)
    SELECT matched.id,matched.api_key_id,NEW.id,NEW.namespace,1,matched.similarity
    FROM matched ORDER BY matched.similarity DESC,matched.id LIMIT 100
    ON CONFLICT(subscription_id,memory_id,event_version) DO NOTHING RETURNING 1
  )
  INSERT INTO public.subscription_match_truncations(memory_id,namespace)
  SELECT NEW.id,NEW.namespace WHERE (SELECT count(*) FROM matched)>100 AND (SELECT count(*) FROM enqueued)>=0
  ON CONFLICT(memory_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_memory_subscription_webhooks() FROM PUBLIC,total_recall_app;

CREATE FUNCTION public.enqueue_shadow_subscription_webhooks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pending public.shadow_subscription_insert_events%ROWTYPE;
BEGIN
  IF NOT NEW.is_current OR NEW.contract_id <> '4340ee2917358817a4fe69234f137eb29580dd799266b783725f13c5a66d5f9e' THEN RETURN NEW; END IF;
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
CREATE TRIGGER memory_embedding_manifest_subscription_enqueue
AFTER INSERT OR UPDATE ON public.memory_embedding_manifests
FOR EACH ROW EXECUTE FUNCTION public.enqueue_shadow_subscription_webhooks();

-- A newly current query target retries a bounded page of durable insert events
-- that could not be consumed when their parent manifest first completed.
CREATE FUNCTION public.retry_shadow_subscription_events_for_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.contract_id <> '4340ee2917358817a4fe69234f137eb29580dd799266b783725f13c5a66d5f9e'
    OR NOT EXISTS (SELECT 1 FROM public.memory_subscriptions s WHERE s.id=NEW.subscription_id
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
CREATE TRIGGER subscription_embedding_target_retry_events
AFTER INSERT OR UPDATE ON public.subscription_embedding_targets
FOR EACH ROW EXECUTE FUNCTION public.retry_shadow_subscription_events_for_target();
