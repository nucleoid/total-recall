-- Prospective semantic memory subscriptions and a transactional webhook outbox (#56).
-- Matching is deliberately INSERT-only, normal-only, same-embedding-space, and bounded.
-- This composite key makes agent provenance tenant-bound at the database boundary.
ALTER TABLE public.agents ADD CONSTRAINT agents_api_key_id_id_unique UNIQUE (api_key_id, id);

CREATE TABLE public.memory_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  created_by_agent_id UUID,
  query_text TEXT NOT NULL CHECK (char_length(query_text) BETWEEN 1 AND 8192),
  query_embedding VECTOR(768) NOT NULL,
  embedding_provider TEXT NOT NULL CHECK (embedding_provider <> ''),
  embedding_model TEXT NOT NULL CHECK (embedding_model <> ''),
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions = 768),
  threshold DOUBLE PRECISION NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  access_level_policy TEXT NOT NULL DEFAULT 'normal' CHECK (access_level_policy = 'normal'),
  exclude_self BOOLEAN NOT NULL DEFAULT true,
  webhook_url_ciphertext BYTEA NOT NULL,
  webhook_url_iv BYTEA NOT NULL CHECK (octet_length(webhook_url_iv) = 12),
  webhook_url_tag BYTEA NOT NULL CHECK (octet_length(webhook_url_tag) = 16),
  signing_secret_ciphertext BYTEA NOT NULL,
  signing_secret_iv BYTEA NOT NULL CHECK (octet_length(signing_secret_iv) = 12),
  signing_secret_tag BYTEA NOT NULL CHECK (octet_length(signing_secret_tag) = 16),
  encryption_key_id TEXT NOT NULL CHECK (encryption_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (api_key_id, idempotency_key),
  UNIQUE (api_key_id, id),
  FOREIGN KEY (api_key_id, created_by_agent_id) REFERENCES public.agents(api_key_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL))
);
CREATE INDEX memory_subscriptions_match_idx ON public.memory_subscriptions
  (embedding_provider, embedding_model, embedding_dimensions, id) WHERE status = 'active';

CREATE TABLE public.subscription_namespaces (
  subscription_id UUID NOT NULL,
  api_key_id UUID NOT NULL,
  namespace TEXT NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 512 AND position(',' in namespace) = 0),
  PRIMARY KEY (subscription_id, namespace),
  FOREIGN KEY (api_key_id, subscription_id) REFERENCES public.memory_subscriptions(api_key_id, id) ON DELETE CASCADE
);
CREATE INDEX subscription_namespaces_match_idx ON public.subscription_namespaces (namespace, subscription_id);

CREATE TABLE public.webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  subscription_id UUID NOT NULL,
  api_key_id UUID NOT NULL,
  -- Deliberately not an FK: hard deletion must not be blocked, while this
  -- content-free delivery audit may retain the former opaque memory ID.
  memory_id UUID NOT NULL,
  namespace TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  similarity DOUBLE PRECISION NOT NULL CHECK (similarity >= -1 AND similarity <= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'delivered', 'dead', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  locked_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_http_status INTEGER CHECK (last_http_status BETWEEN 100 AND 599),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (api_key_id, subscription_id) REFERENCES public.memory_subscriptions(api_key_id, id) ON DELETE RESTRICT,
  UNIQUE (subscription_id, memory_id, event_version)
);
CREATE INDEX webhook_deliveries_claim_idx ON public.webhook_deliveries
  (next_attempt_at, created_at, id) WHERE status IN ('pending', 'retry', 'processing');
CREATE INDEX webhook_deliveries_subscription_idx ON public.webhook_deliveries (subscription_id, created_at DESC);

CREATE TABLE public.subscription_match_truncations (
  -- Deliberately not an FK for the same hard-deletion compatibility reason.
  memory_id UUID PRIMARY KEY,
  namespace TEXT NOT NULL,
  match_cap INTEGER NOT NULL DEFAULT 100 CHECK (match_cap = 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

-- Attribute terminal outcomes to the subscription owner without allowing the
-- cross-tenant worker transaction to forge arbitrary owner audit rows.
CREATE OR REPLACE FUNCTION public.audit_webhook_delivery_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('delivered', 'dead') THEN
    INSERT INTO public.audit_log (client_id, action, namespace, memory_id, result_count)
    VALUES (NEW.api_key_id::text,
      CASE NEW.status WHEN 'delivered' THEN 'webhook.delivered' ELSE 'webhook.dead_letter' END,
      NEW.namespace, NEW.memory_id, NEW.attempts);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_webhook_delivery_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_webhook_delivery_transition() FROM total_recall_app;
CREATE TRIGGER webhook_delivery_audit
AFTER UPDATE OF status ON public.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION public.audit_webhook_delivery_transition();

ALTER TABLE public.memory_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_match_truncations ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_subscriptions_owner_all ON public.memory_subscriptions
  USING (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true')
  WITH CHECK (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true');
CREATE POLICY subscription_namespaces_owner_all ON public.subscription_namespaces
  USING (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true')
  WITH CHECK (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true');
CREATE POLICY webhook_deliveries_owner_all ON public.webhook_deliveries
  USING (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true')
  WITH CHECK (api_key_id::text = current_setting('app.current_key_id', true)
    OR current_setting('app.current_key_is_admin', true) = 'true');
CREATE POLICY subscription_match_truncations_namespace_select ON public.subscription_match_truncations FOR SELECT
  USING (namespace = ANY(public.app_allowed_namespaces()));

GRANT SELECT, INSERT, UPDATE ON public.memory_subscriptions TO total_recall_app;
GRANT SELECT, INSERT, DELETE ON public.subscription_namespaces TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.webhook_deliveries TO total_recall_app;
GRANT SELECT ON public.subscription_match_truncations TO total_recall_app;

-- This privileged function performs only deterministic database matching. It has
-- no network capability, uses a fixed search_path, and is not directly callable.
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

DROP TRIGGER IF EXISTS memories_subscription_enqueue ON public.memories;
CREATE TRIGGER memories_subscription_enqueue
AFTER INSERT ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.enqueue_memory_subscription_webhooks();
-- Enqueue is an explicit operator rollout step and a true database-side kill
-- switch. Creation and delivery environment gates cannot control a DB trigger.
ALTER TABLE public.memories DISABLE TRIGGER memories_subscription_enqueue;
