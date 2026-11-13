-- Additive, default-off durable memory acceptance. No payload is stored here.
CREATE TABLE public.memory_ingestion_jobs (
  memory_id UUID PRIMARY KEY,
  namespace TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('normal','sensitive','secret')),
  allowed_namespaces TEXT[] NOT NULL,
  agent_id UUID,
  session_id TEXT,
  source_key TEXT,
  dedupe BOOLEAN NOT NULL,
  ttl_seconds BIGINT,
  contradiction_eligible BOOLEAN NOT NULL,
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INT NOT NULL CHECK (embedding_dimensions = 768),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','processing','retry_wait','ready','deduplicated','embedding_failed','cancelled')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  locked_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  lease_token UUID,
  last_error_code TEXT CHECK (last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  failure_category TEXT CHECK (failure_category IN
    ('transient','rate_limited','provider_auth','input_rejected','space_mismatch','expired')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  ready_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  canonical_memory_id UUID,
  similarity DOUBLE PRECISION,
  requeued_by TEXT,
  requeued_at TIMESTAMPTZ,
  inline_attempted BOOLEAN NOT NULL DEFAULT false,
  inline_ready BOOLEAN NOT NULL DEFAULT false,
  FOREIGN KEY (namespace, memory_id) REFERENCES public.memories(namespace, id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX memory_ingestion_claim_idx ON public.memory_ingestion_jobs
  (next_attempt_at, accepted_at, memory_id) WHERE status IN ('pending','retry_wait','processing');
CREATE INDEX memory_ingestion_owner_idx ON public.memory_ingestion_jobs (client_id, status);
ALTER TABLE public.memory_ingestion_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingestion_read ON public.memory_ingestion_jobs FOR SELECT USING (
  namespace = ANY(app_allowed_namespaces()) AND
  (client_id = app_current_key_id() OR app_current_key_is_admin())
);
-- #161: admin session workers insert facts attributed to the accepting owner.
CREATE POLICY ingestion_insert ON public.memory_ingestion_jobs FOR INSERT WITH CHECK (
  namespace = ANY(app_allowed_namespaces()) AND
  (client_id = app_current_key_id() OR app_current_key_is_admin())
);
CREATE POLICY ingestion_update ON public.memory_ingestion_jobs FOR UPDATE USING (
  namespace = ANY(app_allowed_namespaces()) AND
  (client_id = app_current_key_id() OR app_current_key_is_admin())
) WITH CHECK (
  namespace = ANY(app_allowed_namespaces()) AND
  (client_id = app_current_key_id() OR app_current_key_is_admin())
);
GRANT SELECT, INSERT, UPDATE ON public.memory_ingestion_jobs TO total_recall_app;

ALTER TABLE public.instance_settings
  ADD COLUMN ingestion_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ingestion_worker_seen_at TIMESTAMPTZ;
-- Runtime cannot change instance identity. An admin-scoped function owns the two fields.
CREATE FUNCTION public.app_ingestion_control(p_paused BOOLEAN, p_heartbeat BOOLEAN DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.app_current_key_is_admin() THEN
    RAISE EXCEPTION 'ingestion control requires admin' USING ERRCODE = '42501';
  END IF;
  UPDATE public.instance_settings SET
    ingestion_paused = COALESCE(p_paused, ingestion_paused),
    ingestion_worker_seen_at = CASE WHEN p_heartbeat THEN statement_timestamp() ELSE ingestion_worker_seen_at END
  WHERE singleton;
END $$;
REVOKE ALL ON FUNCTION public.app_ingestion_control(BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ingestion_control(BOOLEAN, BOOLEAN) TO total_recall_app;

-- The namespace reader sees state only; owner detail remains private under RLS.
CREATE FUNCTION public.app_memory_ingestion_state(p_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.status FROM public.memory_ingestion_jobs j
  WHERE j.memory_id = p_id AND j.namespace = ANY(public.app_allowed_namespaces())
$$;
REVOKE ALL ON FUNCTION public.app_memory_ingestion_state(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_memory_ingestion_state(UUID) TO total_recall_app;

-- Qualify the matching CTE: NEW.id also names an output id in the outbox INSERT.
CREATE OR REPLACE FUNCTION public.enqueue_memory_subscription_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
CREATE TRIGGER memories_subscription_ready_enqueue
AFTER UPDATE OF embedding ON public.memories
FOR EACH ROW WHEN (OLD.embedding IS NULL AND NEW.embedding IS NOT NULL AND NEW.memory_kind <> 'episode_chunk')
EXECUTE FUNCTION public.enqueue_memory_subscription_webhooks();
ALTER TABLE public.memories DISABLE TRIGGER memories_subscription_ready_enqueue;
