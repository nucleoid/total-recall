-- Additive, disabled-by-default derived index. No canonical vector/text is rewritten.
CREATE TABLE public.embedding_contracts (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  canonical_json TEXT NOT NULL CHECK (jsonb_typeof(canonical_json::jsonb) = 'object'),
  capture_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (id = encode(digest(canonical_json, 'sha256'), 'hex'))
);

CREATE FUNCTION public.guard_embedding_contract_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.canonical_json IS DISTINCT FROM OLD.canonical_json THEN
    RAISE EXCEPTION 'embedding.immutable_contract';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_contract_identity BEFORE UPDATE ON public.embedding_contracts
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_contract_identity();

CREATE TABLE public.embedding_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  release_sha TEXT NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','running','paused','failed','complete')),
  source_watermark TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  memory_cursor UUID,
  subscription_cursor UUID,
  inventory_complete BOOLEAN NOT NULL DEFAULT false,
  last_error_code TEXT CHECK (last_error_code ~ '^[a-z0-9_.]{1,96}$'),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX embedding_one_running_contract ON public.embedding_runs(contract_id)
WHERE status = 'running';

CREATE FUNCTION public.guard_embedding_run_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.release_sha IS DISTINCT FROM OLD.release_sha OR NEW.manifest IS DISTINCT FROM OLD.manifest
    OR NEW.source_watermark IS DISTINCT FROM OLD.source_watermark THEN
    RAISE EXCEPTION 'embedding.immutable_run';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_run_identity BEFORE UPDATE ON public.embedding_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_run_identity();

CREATE TABLE public.embedding_work_items (
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  parent_type TEXT NOT NULL CHECK (parent_type IN ('memory','subscription')),
  parent_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','retry','failed','complete','excluded')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  claimed_by UUID,
  lease_until TIMESTAMPTZ,
  -- Counts retryable processing failures, not claims/takeovers or planned batch boundaries.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  source_sha256 TEXT CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_revision INTEGER,
  error_code TEXT CHECK (error_code ~ '^[a-z0-9_.]{1,96}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (contract_id,parent_type,parent_id),
  CHECK ((state = 'claimed') = (claimed_by IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX embedding_work_claim_idx ON public.embedding_work_items(contract_id,next_attempt_at,parent_type,parent_id)
WHERE state IN ('pending','retry','claimed');

CREATE TABLE public.memory_embedding_manifests (
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  parent_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_revision INTEGER NOT NULL,
  source_bytes INTEGER NOT NULL CHECK (source_bytes BETWEEN 0 AND 1048576),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  total_tokens BIGINT NOT NULL CHECK (total_tokens >= 0),
  is_current BOOLEAN NOT NULL DEFAULT false,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(contract_id,parent_id)
);

-- Each accepted contract gets its own partition and ANN index through the
-- owner-only preparation command. There is deliberately no mixed-space default.
CREATE TABLE public.memory_embedding_chunks (
  contract_id TEXT NOT NULL,
  parent_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  core_start INTEGER NOT NULL CHECK (core_start >= 0),
  core_end INTEGER NOT NULL CHECK (core_end >= core_start),
  chunk_sha256 TEXT NOT NULL CHECK (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  formatted_tokens INTEGER NOT NULL CHECK (formatted_tokens BETWEEN 0 AND 256),
  embedding VECTOR(768) NOT NULL CHECK (abs(vector_norm(embedding) - 1) < 0.00001),
  PRIMARY KEY(contract_id,parent_id,ordinal),
  FOREIGN KEY(contract_id,parent_id) REFERENCES public.memory_embedding_manifests(contract_id,parent_id) ON DELETE CASCADE
) PARTITION BY LIST(contract_id);

CREATE TABLE public.subscription_embedding_targets (
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  subscription_id UUID NOT NULL REFERENCES public.memory_subscriptions(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  formatted_tokens INTEGER NOT NULL CHECK (formatted_tokens BETWEEN 0 AND 2000),
  embedding VECTOR(768) NOT NULL CHECK (abs(vector_norm(embedding) - 1) < 0.00001),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(contract_id,subscription_id)
);

-- All existing/future SQL writers are captured transactionally. No inference or
-- network call occurs under a parent transaction. Changed work fences old claims.
CREATE FUNCTION public.capture_shadow_embedding_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind TEXT;
BEGIN
  kind := CASE TG_TABLE_NAME WHEN 'memories' THEN 'memory' ELSE 'subscription' END;
  IF TG_OP = 'UPDATE' THEN
    IF kind = 'memory' THEN
      UPDATE public.memory_embedding_manifests SET is_current = false
      WHERE parent_id = NEW.id AND is_current;
    ELSE
      DELETE FROM public.subscription_embedding_targets WHERE subscription_id = NEW.id;
    END IF;
  END IF;
  INSERT INTO public.embedding_work_items(contract_id,parent_type,parent_id)
  SELECT id,kind,NEW.id FROM public.embedding_contracts WHERE capture_enabled
  ON CONFLICT (contract_id,parent_type,parent_id) DO UPDATE SET
    state='pending',generation=embedding_work_items.generation+1,claimed_by=NULL,lease_until=NULL,
    attempts=0,next_attempt_at=statement_timestamp(),source_sha256=NULL,source_revision=NULL,
    error_code=NULL,updated_at=statement_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_shadow_embedding_work() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_shadow_embedding_work() FROM total_recall_app;
CREATE TRIGGER capture_memory_shadow_insert AFTER INSERT ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.capture_shadow_embedding_work();
CREATE TRIGGER capture_memory_shadow_update
-- UPDATE OF only observes the caller's SET list, not revision changes made by
-- the BEFORE trigger (for example a tags/metadata edit). Inspect every update.
AFTER UPDATE
ON public.memories FOR EACH ROW
WHEN (OLD.content IS DISTINCT FROM NEW.content OR OLD.revision IS DISTINCT FROM NEW.revision
  OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at
  OR OLD.consolidated_into_id IS DISTINCT FROM NEW.consolidated_into_id OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
  OR OLD.valid_from IS DISTINCT FROM NEW.valid_from OR OLD.valid_to IS DISTINCT FROM NEW.valid_to)
EXECUTE FUNCTION public.capture_shadow_embedding_work();
CREATE TRIGGER capture_subscription_shadow_insert AFTER INSERT ON public.memory_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.capture_shadow_embedding_work();
CREATE TRIGGER capture_subscription_shadow_update AFTER UPDATE OF query_text,status ON public.memory_subscriptions
FOR EACH ROW WHEN (OLD.query_text IS DISTINCT FROM NEW.query_text OR OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.capture_shadow_embedding_work();

ALTER TABLE public.memory_embedding_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_embedding_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_embedding_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_embedding_manifest_parent_select ON public.memory_embedding_manifests FOR SELECT
USING (is_current AND EXISTS (SELECT 1 FROM public.memories m
  WHERE m.id = parent_id AND m.revision = source_revision AND m.deleted_at IS NULL
    AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
    AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
    AND (m.valid_to IS NULL OR m.valid_to > statement_timestamp())));
CREATE POLICY memory_embedding_chunk_parent_select ON public.memory_embedding_chunks FOR SELECT
USING (EXISTS (SELECT 1 FROM public.memory_embedding_manifests f
  WHERE f.contract_id = memory_embedding_chunks.contract_id AND f.parent_id = memory_embedding_chunks.parent_id));
CREATE POLICY subscription_embedding_target_owner_select ON public.subscription_embedding_targets FOR SELECT
USING (EXISTS (SELECT 1 FROM public.memory_subscriptions s WHERE s.id = subscription_id AND s.status = 'active'
  AND encode(digest(s.query_text,'sha256'),'hex') = source_sha256));
GRANT SELECT ON public.memory_embedding_manifests, public.memory_embedding_chunks,
  public.subscription_embedding_targets TO total_recall_app;
-- Contracts, run manifests and cross-tenant queue state remain operator-only.
REVOKE ALL ON public.embedding_contracts, public.embedding_runs, public.embedding_work_items FROM PUBLIC, total_recall_app;
