-- #160: additive document chunk provenance; applied 037/038 remain immutable.
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
