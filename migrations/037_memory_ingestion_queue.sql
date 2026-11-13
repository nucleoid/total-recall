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

CREATE TRIGGER memories_subscription_ready_enqueue
AFTER UPDATE OF embedding ON public.memories
FOR EACH ROW WHEN (OLD.embedding IS NULL AND NEW.embedding IS NOT NULL AND NEW.memory_kind <> 'episode_chunk')
EXECUTE FUNCTION public.enqueue_memory_subscription_webhooks();
ALTER TABLE public.memories DISABLE TRIGGER memories_subscription_ready_enqueue;
