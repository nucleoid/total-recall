-- Durable write-ahead ingestion queue for memory_store (#157).
-- Accepted content lives in public.memories with a NULL embedding; this table
-- carries only the job state machine and the immutable security/provenance
-- snapshot a later finalizer needs. Job rows are content-free by construction.
-- The migration is additive: no backfill, no reindex, and old binaries that
-- never write NULL embeddings ignore the table entirely.

-- Operator pause/drain switch and worker heartbeat, read by the stats surface.
ALTER TABLE public.instance_settings
  ADD COLUMN IF NOT EXISTS ingestion_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ingestion_worker_seen_at TIMESTAMPTZ;
GRANT UPDATE (ingestion_paused, ingestion_worker_seen_at) ON public.instance_settings TO total_recall_app;

-- The composite tenant FK reuses memories_namespace_id_unique from migration
-- 028, so a forget/purge while pending cancels the job and a keyed namespace
-- move keeps the job aligned.
CREATE TABLE IF NOT EXISTS public.memory_ingestion_jobs (
  memory_id UUID PRIMARY KEY,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store', 'update', 'document')),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  document_id UUID,
  chunk_index INTEGER CHECK (chunk_index IS NULL OR chunk_index >= 0),
  -- Immutable security/provenance snapshot taken at acceptance. Finalization
  -- runs under exactly this scope even if the key is later revoked.
  client_id TEXT NOT NULL,
  access_level TEXT NOT NULL,
  allowed_namespaces TEXT[] NOT NULL,
  agent_id UUID,
  session_id TEXT,
  source_key TEXT,
  dedupe BOOLEAN NOT NULL,
  ttl_seconds BIGINT CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  contradiction_eligible BOOLEAN NOT NULL,
  -- Embedding target captured from the active profile at acceptance. The
  -- worker refuses to finalize into a different vector space.
  embedding_provider TEXT NOT NULL CHECK (embedding_provider <> ''),
  embedding_model TEXT NOT NULL CHECK (embedding_model <> ''),
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'retry_wait', 'ready', 'deduplicated', 'embedding_failed', 'cancelled'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  locked_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  lease_token UUID,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  failure_category TEXT CHECK (failure_category IS NULL OR failure_category IN (
    'transient', 'rate_limited', 'provider_auth', 'input_rejected', 'space_mismatch', 'expired'
  )),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  ready_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  canonical_memory_id UUID,
  similarity DOUBLE PRECISION CHECK (similarity IS NULL OR (similarity >= -1 AND similarity <= 1)),
  requeued_by TEXT,
  requeued_at TIMESTAMPTZ,
  FOREIGN KEY (namespace, memory_id) REFERENCES public.memories(namespace, id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_ingestion_jobs_claim_idx ON public.memory_ingestion_jobs
  (next_attempt_at, accepted_at, memory_id) WHERE status IN ('pending', 'retry_wait', 'processing');
CREATE INDEX IF NOT EXISTS memory_ingestion_jobs_owner_idx ON public.memory_ingestion_jobs (client_id, status);
CREATE INDEX IF NOT EXISTS memory_ingestion_jobs_document_idx ON public.memory_ingestion_jobs
  (document_id, status) WHERE document_id IS NOT NULL;

ALTER TABLE public.memory_ingestion_jobs ENABLE ROW LEVEL SECURITY;

-- Owners see and finalize their own jobs inside their namespace scope. Admin
-- identities (the dedicated ingestion worker key, and session workers that
-- write owner-attributed rows) may claim, insert and update within scope.
-- There is deliberately no DELETE policy or grant: the FK cascade is the only
-- way a job row disappears.
DROP POLICY IF EXISTS memory_ingestion_jobs_owner_select ON public.memory_ingestion_jobs;
CREATE POLICY memory_ingestion_jobs_owner_select ON public.memory_ingestion_jobs FOR SELECT
  USING ((client_id = public.app_current_key_id() OR public.app_current_key_is_admin())
    AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS memory_ingestion_jobs_owner_insert ON public.memory_ingestion_jobs;
CREATE POLICY memory_ingestion_jobs_owner_insert ON public.memory_ingestion_jobs FOR INSERT
  WITH CHECK ((client_id = public.app_current_key_id() OR public.app_current_key_is_admin())
    AND namespace = ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS memory_ingestion_jobs_owner_update ON public.memory_ingestion_jobs;
CREATE POLICY memory_ingestion_jobs_owner_update ON public.memory_ingestion_jobs FOR UPDATE
  USING ((client_id = public.app_current_key_id() OR public.app_current_key_is_admin())
    AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK ((client_id = public.app_current_key_id() OR public.app_current_key_is_admin())
    AND namespace = ANY(public.app_allowed_namespaces()));

GRANT SELECT, INSERT, UPDATE ON public.memory_ingestion_jobs TO total_recall_app;
-- Queue deletion is intentionally unavailable to runtime identities.

-- The subscription enqueue function keeps its full migration 029 body. The only
-- addition is an early return when the memory being finalized belongs to an
-- update-kind job: a re-embed after a content update is not a creation event.
-- The function is SECURITY DEFINER, so it can read the job table regardless of
-- the caller's RLS scope.
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

  IF EXISTS (
    SELECT 1 FROM public.memory_ingestion_jobs j
    WHERE j.memory_id = NEW.id AND j.kind = 'update'
  ) THEN
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
    SELECT id, api_key_id, NEW.id, NEW.namespace, 1, similarity
    FROM matched ORDER BY similarity DESC, id LIMIT 100
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
REVOKE ALL ON FUNCTION public.enqueue_memory_subscription_webhooks() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_memory_subscription_webhooks() FROM total_recall_app;

-- The pending -> ready transition is the creation event for a queued memory.
-- The 029 insert trigger returns early on a NULL embedding, so without this
-- trigger a queued memory would never notify. Episode chunks stay excluded
-- exactly as they are on insert. Shipped disabled, same as the insert trigger:
-- enabling both together is an explicit operator rollout step and the
-- database-side kill switch.
DROP TRIGGER IF EXISTS memories_ingestion_subscription_enqueue ON public.memories;
CREATE TRIGGER memories_ingestion_subscription_enqueue
AFTER UPDATE OF embedding ON public.memories
FOR EACH ROW WHEN (OLD.embedding IS NULL AND NEW.embedding IS NOT NULL AND NEW.memory_kind <> 'episode_chunk')
EXECUTE FUNCTION public.enqueue_memory_subscription_webhooks();
ALTER TABLE public.memories DISABLE TRIGGER memories_ingestion_subscription_enqueue;
