-- Dedicated delivery-only webhook worker lane. The worker API key is intentionally
-- not a read, write, delete, or admin credential. All cross-owner access is limited
-- to these fixed-shape functions and the key's live namespace scope.

CREATE OR REPLACE FUNCTION public.app_webhook_worker_scope_allowed(p_namespace text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.api_keys key
    WHERE key.id::text = public.app_current_key_id()
      AND key.enabled = true
      AND key.revoked_at IS NULL
      AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
      AND key.permissions = ARRAY['webhook_worker']::text[]
      AND (
        p_namespace IS NULL
        OR (
          p_namespace = ANY(public.app_allowed_namespaces())
          AND p_namespace = ANY(key.namespaces)
        )
      )
  )
$$;
REVOKE ALL ON FUNCTION public.app_webhook_worker_scope_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_webhook_worker_scope_allowed(text) TO total_recall_app;

-- Restrictive policies compose with every existing and future permissive policy.
-- They preserve migration 057's entity-worker guards while making raw app-role
-- table access fail closed for a webhook-only key.
DROP POLICY IF EXISTS webhook_worker_raw_deny ON public.memories;
CREATE POLICY webhook_worker_raw_deny ON public.memories AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('webhook_worker'))
  WITH CHECK (NOT public.app_current_key_has_permission('webhook_worker'));
DROP POLICY IF EXISTS webhook_worker_raw_deny ON public.documents;
CREATE POLICY webhook_worker_raw_deny ON public.documents AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('webhook_worker'))
  WITH CHECK (NOT public.app_current_key_has_permission('webhook_worker'));
DROP POLICY IF EXISTS webhook_worker_raw_deny ON public.memory_subscriptions;
CREATE POLICY webhook_worker_raw_deny ON public.memory_subscriptions AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('webhook_worker'))
  WITH CHECK (NOT public.app_current_key_has_permission('webhook_worker'));
DROP POLICY IF EXISTS webhook_worker_raw_deny ON public.subscription_namespaces;
CREATE POLICY webhook_worker_raw_deny ON public.subscription_namespaces AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('webhook_worker'))
  WITH CHECK (NOT public.app_current_key_has_permission('webhook_worker'));
DROP POLICY IF EXISTS webhook_worker_raw_deny ON public.webhook_deliveries;
CREATE POLICY webhook_worker_raw_deny ON public.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('webhook_worker'))
  WITH CHECK (NOT public.app_current_key_has_permission('webhook_worker'));

CREATE OR REPLACE FUNCTION public.webhook_worker_claim_delivery()
RETURNS TABLE (id uuid, event_id uuid, subscription_id uuid, api_key_id uuid, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT delivery.id
    FROM public.webhook_deliveries delivery
    WHERE public.app_webhook_worker_scope_allowed(delivery.namespace)
      AND ((delivery.status IN ('pending', 'retry') AND delivery.next_attempt_at <= statement_timestamp())
        OR (delivery.status = 'processing'
          AND delivery.locked_at < statement_timestamp() - interval '5 minutes'))
    ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.id
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE public.webhook_deliveries delivery
  SET status = 'processing', attempts = delivery.attempts + 1,
      locked_at = statement_timestamp(), last_error_code = NULL,
      updated_at = statement_timestamp()
  FROM candidate WHERE delivery.id = candidate.id
  RETURNING delivery.id, delivery.event_id, delivery.subscription_id,
    delivery.api_key_id, delivery.attempts;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_claim_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_claim_delivery() TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_load_delivery(p_delivery_id uuid)
RETURNS TABLE (
  id uuid, event_id uuid, subscription_id uuid, api_key_id uuid, memory_id uuid,
  namespace text, similarity double precision, event_created_at timestamptz,
  memory_created_at timestamptz, webhook_url_ciphertext bytea, webhook_url_iv bytea,
  webhook_url_tag bytea, signing_secret_ciphertext bytea, signing_secret_iv bytea,
  signing_secret_tag bytea, encryption_key_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT delivery.id, delivery.event_id, delivery.subscription_id, delivery.api_key_id,
    delivery.memory_id, delivery.namespace, delivery.similarity,
    delivery.created_at, memory.created_at,
    subscription.webhook_url_ciphertext, subscription.webhook_url_iv, subscription.webhook_url_tag,
    subscription.signing_secret_ciphertext, subscription.signing_secret_iv,
    subscription.signing_secret_tag, subscription.encryption_key_id
  FROM public.webhook_deliveries delivery
  JOIN public.memory_subscriptions subscription
    ON subscription.id = delivery.subscription_id AND subscription.api_key_id = delivery.api_key_id
  JOIN public.subscription_namespaces subscription_namespace
    ON subscription_namespace.subscription_id = subscription.id
    AND subscription_namespace.api_key_id = subscription.api_key_id
    AND subscription_namespace.namespace = delivery.namespace
  JOIN public.api_keys owner_key ON owner_key.id = subscription.api_key_id
  JOIN public.memories memory ON memory.id = delivery.memory_id AND memory.namespace = delivery.namespace
  WHERE delivery.id = p_delivery_id AND delivery.status = 'processing'
    AND public.app_webhook_worker_scope_allowed(delivery.namespace)
    AND subscription.status = 'active' AND subscription.access_level_policy = 'normal'
    AND owner_key.enabled = true AND owner_key.revoked_at IS NULL
    AND (owner_key.expires_at IS NULL OR owner_key.expires_at > statement_timestamp())
    AND 'read' = ANY(owner_key.permissions) AND delivery.namespace = ANY(owner_key.namespaces)
    AND COALESCE(memory.access_level, 'normal') = 'normal'
    AND (NOT subscription.exclude_self OR memory.client_id <> subscription.api_key_id::text)
    AND memory.deleted_at IS NULL
    AND (memory.expires_at IS NULL OR memory.expires_at > statement_timestamp())
    AND memory.superseded_at IS NULL AND memory.valid_to IS NULL
    AND (memory.valid_from IS NULL OR memory.valid_from <= statement_timestamp())
    AND memory.consolidated_into_id IS NULL
  FOR SHARE OF subscription, owner_key, memory;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_load_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_load_delivery(uuid) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_recheck_delivery(p_delivery_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE authorized boolean;
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.webhook_worker_load_delivery(p_delivery_id)) INTO authorized;
  RETURN authorized;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_recheck_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_recheck_delivery(uuid) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_cancel_unauthorized(p_delivery_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.webhook_deliveries delivery
  SET status = 'cancelled', locked_at = NULL,
      last_error_code = 'authorization_revoked', updated_at = statement_timestamp()
  WHERE delivery.id = p_delivery_id AND delivery.status = 'processing'
    AND public.app_webhook_worker_scope_allowed(delivery.namespace)
    AND NOT EXISTS (SELECT 1 FROM public.webhook_worker_load_delivery(delivery.id));
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_cancel_unauthorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_cancel_unauthorized(uuid) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_mark_delivered(p_delivery_id uuid, p_http_status integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_http_status < 200 OR p_http_status > 299 THEN
    RAISE EXCEPTION 'delivered webhook status must be 2xx' USING ERRCODE = '22023';
  END IF;
  UPDATE public.webhook_deliveries delivery
  SET status = 'delivered', delivered_at = statement_timestamp(), locked_at = NULL,
      last_http_status = p_http_status, last_error_code = NULL, updated_at = statement_timestamp()
  WHERE delivery.id = p_delivery_id AND delivery.status = 'processing'
    AND public.app_webhook_worker_scope_allowed(delivery.namespace);
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_mark_delivered(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_mark_delivered(uuid, integer) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_mark_retry(
  p_delivery_id uuid, p_error_code text, p_http_status integer, p_retry_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.-]{1,64}$'
     OR (p_http_status IS NOT NULL AND (p_http_status < 100 OR p_http_status > 599))
     OR p_retry_at IS NULL THEN
    RAISE EXCEPTION 'invalid content-free webhook retry outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE public.webhook_deliveries delivery
  SET status = 'retry', next_attempt_at = p_retry_at, locked_at = NULL,
      last_http_status = p_http_status, last_error_code = p_error_code,
      updated_at = statement_timestamp()
  WHERE delivery.id = p_delivery_id AND delivery.status = 'processing'
    AND delivery.attempts < 6 AND public.app_webhook_worker_scope_allowed(delivery.namespace);
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_mark_retry(uuid, text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_mark_retry(uuid, text, integer, timestamptz) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.webhook_worker_mark_dead(
  p_delivery_id uuid, p_error_code text, p_http_status integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.app_webhook_worker_scope_allowed(NULL) THEN
    RAISE EXCEPTION 'webhook worker key is not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.-]{1,64}$'
     OR (p_http_status IS NOT NULL AND (p_http_status < 100 OR p_http_status > 599)) THEN
    RAISE EXCEPTION 'invalid content-free webhook terminal outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE public.webhook_deliveries delivery
  SET status = 'dead', locked_at = NULL, last_http_status = p_http_status,
      last_error_code = p_error_code, updated_at = statement_timestamp()
  WHERE delivery.id = p_delivery_id AND delivery.status = 'processing'
    AND public.app_webhook_worker_scope_allowed(delivery.namespace);
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.webhook_worker_mark_dead(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_worker_mark_dead(uuid, text, integer) TO total_recall_app;
