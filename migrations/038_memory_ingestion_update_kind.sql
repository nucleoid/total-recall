-- #159: additive update generations; leave applied migration 037 unchanged.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.memory_ingestion_jobs
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store','update','document')),
  ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;

-- Namespace writers can edit memories accepted by another key. Lock the private
-- job before the memory without exposing its owner-only status or attribution.
CREATE FUNCTION public.app_lock_memory_ingestion(p_ids UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM j.memory_id FROM public.memory_ingestion_jobs j
  WHERE j.memory_id = ANY(p_ids) AND j.namespace = ANY(public.app_allowed_namespaces())
  ORDER BY j.memory_id FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION public.app_lock_memory_ingestion(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_lock_memory_ingestion(UUID[]) TO total_recall_app;

-- Replace only a currently authorized, already patched, unembedded generation.
-- SECURITY DEFINER is needed to replace another writer's private job; its detail
-- stays protected by the existing owner-only RLS policies.
CREATE FUNCTION public.app_enqueue_memory_reembed(p_id UUID, p_provider TEXT, p_model TEXT, p_dimensions INTEGER)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE accepted TIMESTAMPTZ;
BEGIN
  INSERT INTO public.memory_ingestion_jobs
    (memory_id, namespace, client_id, access_level, allowed_namespaces, agent_id, session_id,
     source_key, dedupe, contradiction_eligible, embedding_provider, embedding_model,
     embedding_dimensions, kind, source_revision, memory_created, creation_pending, lease_token)
  SELECT m.id, m.namespace, public.app_current_key_id(), m.access_level, ARRAY[m.namespace],
    m.agent_id, m.session_id, m.source_key, false, false, p_provider, p_model, p_dimensions,
    'update', m.revision, false, false, gen_random_uuid()
  FROM public.memories m JOIN public.api_keys k ON k.id::text = public.app_current_key_id()
  WHERE m.id = p_id AND m.namespace = ANY(public.app_allowed_namespaces())
    AND m.namespace = ANY(k.namespaces) AND 'write' = ANY(k.permissions)
    AND k.enabled AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
    AND (m.access_level = 'normal' OR k.max_access_level = 'secret' OR (m.access_level = 'sensitive' AND k.max_access_level = 'sensitive'))
    AND m.embedding IS NULL AND m.deleted_at IS NULL AND m.superseded_at IS NULL
    AND m.consolidated_into_id IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
  ON CONFLICT (memory_id) DO UPDATE SET
    namespace = EXCLUDED.namespace, client_id = EXCLUDED.client_id, access_level = EXCLUDED.access_level,
    allowed_namespaces = EXCLUDED.allowed_namespaces, agent_id = EXCLUDED.agent_id, session_id = EXCLUDED.session_id,
    source_key = EXCLUDED.source_key, dedupe = false, contradiction_eligible = false, ttl_seconds = NULL,
    embedding_provider = EXCLUDED.embedding_provider, embedding_model = EXCLUDED.embedding_model,
    embedding_dimensions = EXCLUDED.embedding_dimensions, kind = 'update', source_revision = EXCLUDED.source_revision,
    memory_created = false, creation_pending = false, status = 'pending', attempts = 0,
    lease_token = EXCLUDED.lease_token, lease_expires_at = NULL, locked_at = NULL,
    accepted_at = statement_timestamp(), next_attempt_at = statement_timestamp(), ready_at = NULL,
    finalized_at = NULL, canonical_memory_id = NULL, similarity = NULL, failure_category = NULL,
    last_error_code = NULL, inline_attempted = false, inline_ready = false,
    requeued_by = NULL, requeued_at = NULL
  RETURNING accepted_at INTO accepted;
  IF accepted IS NULL THEN RAISE EXCEPTION 'reembed target is not eligible' USING ERRCODE = '42501'; END IF;
  RETURN accepted;
END $$;
REVOKE ALL ON FUNCTION public.app_enqueue_memory_reembed(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_enqueue_memory_reembed(UUID, TEXT, TEXT, INTEGER) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.enqueue_memory_subscription_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
