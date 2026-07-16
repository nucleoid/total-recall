-- Episodic transcript ingestion and durable, provider-neutral distillation queue (#57).
-- This migration stores no transcript text outside ordinary document chunks and
-- does not enable a generation provider or worker.
ALTER TABLE public.documents
  ADD COLUMN access_level TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'document',
  ADD COLUMN session_id TEXT,
  ADD COLUMN session_request_hash TEXT,
  ADD COLUMN agent_id UUID,
  ADD COLUMN content_bytes INTEGER;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_access_level_check
    CHECK (access_level IN ('normal', 'sensitive', 'secret')),
  ADD CONSTRAINT documents_kind_check
    CHECK (document_kind IN ('document', 'session')),
  ADD CONSTRAINT documents_session_shape_check CHECK (
    (document_kind = 'session'
      AND session_request_hash ~ '^sha256:session-v1:[0-9a-f]{64}$'
      AND content_bytes BETWEEN 1 AND 1048576
      AND agent_id IS NOT NULL)
    OR
    (document_kind = 'document'
      AND session_id IS NULL
      AND session_request_hash IS NULL
      AND content_bytes IS NULL
      AND agent_id IS NULL)
  ),
  ADD CONSTRAINT documents_client_agent_fkey
    FOREIGN KEY (client_id, agent_id) REFERENCES public.agents(api_key_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_client_id_id_unique UNIQUE (client_id, id),
  ADD CONSTRAINT documents_namespace_access_id_unique UNIQUE (namespace, access_level, id),
  ADD CONSTRAINT documents_session_composite_unique UNIQUE (client_id, namespace, access_level, id);

CREATE UNIQUE INDEX documents_session_identity_unique
  ON public.documents (client_id, namespace, session_id)
  WHERE document_kind = 'session' AND client_id IS NOT NULL AND session_id IS NOT NULL;
CREATE INDEX documents_session_status_idx
  ON public.documents (client_id, namespace, created_at DESC)
  WHERE document_kind = 'session';

-- #57 introduces an explicit episodic kind. Replacing the check is required
-- because PostgreSQL cannot extend an existing CHECK expression in place.
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_memory_kind_check;
ALTER TABLE public.memories ADD CONSTRAINT memories_memory_kind_check
  CHECK (memory_kind IN (
    'unspecified', 'semantic', 'document_chunk', 'episode_chunk', 'synced',
    'media_rollup', 'consolidation'
  )) NOT VALID;
ALTER TABLE public.memories
  ADD CONSTRAINT memories_client_id_id_unique UNIQUE (client_id, id),
  ADD CONSTRAINT memories_namespace_access_id_unique UNIQUE (namespace, access_level, id),
  ADD CONSTRAINT memories_document_scope_fkey
    FOREIGN KEY (namespace, access_level, document_id)
    REFERENCES public.documents(namespace, access_level, id) ON DELETE RESTRICT NOT VALID;

CREATE TABLE public.memory_session_distillation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  episode_id UUID NOT NULL,
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('normal', 'sensitive', 'secret')),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:session-v1:[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  locked_at TIMESTAMPTZ,
  provider TEXT,
  model TEXT,
  policy_hash TEXT CHECK (policy_hash IS NULL OR policy_hash ~ '^[0-9a-f]{64}$'),
  input_bytes INTEGER CHECK (input_bytes IS NULL OR input_bytes >= 0),
  output_bytes INTEGER CHECK (output_bytes IS NULL OR output_bytes >= 0),
  estimated_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_micro_usd >= 0),
  facts_stored INTEGER NOT NULL DEFAULT 0 CHECK (facts_stored BETWEEN 0 AND 50),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (episode_id),
  UNIQUE (owner_key_id, id),
  UNIQUE (owner_key_id, namespace, access_level, episode_id, id),
  FOREIGN KEY (owner_key_id, namespace, access_level, episode_id)
    REFERENCES public.documents(client_id, namespace, access_level, id) ON DELETE RESTRICT,
  CHECK ((status = 'processing') = (locked_at IS NOT NULL)),
  CHECK ((status IN ('completed', 'dead')) = (completed_at IS NOT NULL)),
  CHECK (status <> 'completed' OR last_error_code IS NULL),
  CHECK (provider IS NULL OR (model IS NOT NULL AND policy_hash IS NOT NULL))
);
CREATE INDEX memory_session_distillation_claim_idx
  ON public.memory_session_distillation_runs (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'retry', 'processing');
CREATE INDEX memory_session_distillation_monthly_budget_idx
  ON public.memory_session_distillation_runs (namespace, provider, model, created_at)
  WHERE estimated_cost_micro_usd > 0;

CREATE TABLE public.memory_session_derivations (
  owner_key_id UUID NOT NULL,
  owner_client_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL,
  run_id UUID NOT NULL,
  episode_id UUID NOT NULL,
  memory_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (episode_id, memory_id),
  FOREIGN KEY (owner_key_id, namespace, access_level, episode_id, run_id)
    REFERENCES public.memory_session_distillation_runs(owner_key_id, namespace, access_level, episode_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (owner_key_id, episode_id)
    REFERENCES public.documents(client_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (namespace, access_level, episode_id)
    REFERENCES public.documents(namespace, access_level, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_client_id, memory_id)
    REFERENCES public.memories(client_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (namespace, access_level, memory_id)
    REFERENCES public.memories(namespace, access_level, id) ON DELETE RESTRICT,
  CHECK (owner_client_id = owner_key_id::text)
);
CREATE INDEX memory_session_derivations_memory_idx
  ON public.memory_session_derivations (memory_id, episode_id);

ALTER TABLE public.memory_session_distillation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_session_derivations ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_session_runs_owner_read ON public.memory_session_distillation_runs FOR SELECT
  USING ((owner_key_id = public.app_current_key_id()::uuid OR public.app_current_key_is_admin())
    AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_session_runs_owner_insert ON public.memory_session_distillation_runs FOR INSERT
  WITH CHECK (owner_key_id = public.app_current_key_id()::uuid
    AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_session_runs_worker_update ON public.memory_session_distillation_runs FOR UPDATE
  USING (public.app_current_key_is_admin() AND namespace = ANY(public.app_allowed_namespaces()))
  WITH CHECK (public.app_current_key_is_admin() AND namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_session_derivations_namespace_read ON public.memory_session_derivations FOR SELECT
  USING (namespace = ANY(public.app_allowed_namespaces()));
CREATE POLICY memory_session_derivations_worker_insert ON public.memory_session_derivations FOR INSERT
  WITH CHECK (public.app_current_key_is_admin() AND namespace = ANY(public.app_allowed_namespaces()));

GRANT SELECT, INSERT, UPDATE ON public.memory_session_distillation_runs TO total_recall_app;
GRANT SELECT, INSERT ON public.memory_session_derivations TO total_recall_app;
-- No runtime DELETE is granted for runs or lineage.

-- Attribute content-free terminal outcomes to the session owner. The worker is
-- intentionally unable to insert arbitrary owner audit rows directly.
CREATE OR REPLACE FUNCTION public.audit_session_distillation_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed', 'dead') THEN
    INSERT INTO public.audit_log (client_id, action, namespace, memory_id, result_count)
    VALUES (NEW.owner_key_id::text,
      CASE NEW.status WHEN 'completed' THEN 'session.distilled' ELSE 'session.distillation_dead' END,
      NEW.namespace, NEW.episode_id, NEW.facts_stored);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_session_distillation_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_session_distillation_transition() FROM total_recall_app;
CREATE TRIGGER memory_session_distillation_audit
AFTER UPDATE OF status ON public.memory_session_distillation_runs
FOR EACH ROW EXECUTE FUNCTION public.audit_session_distillation_transition();

-- Complete transcripts are excluded from every other generative feature and
-- from prospective subscriptions. Those approvals never carry over to #57.
DROP TRIGGER IF EXISTS memories_entity_enrichment_enqueue ON public.memories;
CREATE TRIGGER memories_entity_enrichment_enqueue
AFTER INSERT OR UPDATE OF content, namespace, access_level ON public.memories
FOR EACH ROW WHEN (NEW.memory_kind <> 'episode_chunk')
EXECUTE FUNCTION public.enqueue_memory_entity_enrichment();

-- Preserve #56's independent database kill-switch state while replacing its
-- trigger. A missing/unrecognized prior state fails closed.
DO $$
DECLARE prior_state TEXT;
BEGIN
  SELECT tgenabled INTO prior_state FROM pg_trigger
  WHERE tgrelid = 'public.memories'::regclass AND tgname = 'memories_subscription_enqueue';
  DROP TRIGGER IF EXISTS memories_subscription_enqueue ON public.memories;
  CREATE TRIGGER memories_subscription_enqueue
  AFTER INSERT ON public.memories
  FOR EACH ROW WHEN (NEW.memory_kind <> 'episode_chunk')
  EXECUTE FUNCTION public.enqueue_memory_subscription_webhooks();
  IF prior_state = 'O' THEN
    ALTER TABLE public.memories ENABLE TRIGGER memories_subscription_enqueue;
  ELSIF prior_state = 'A' THEN
    ALTER TABLE public.memories ENABLE ALWAYS TRIGGER memories_subscription_enqueue;
  ELSIF prior_state = 'R' THEN
    ALTER TABLE public.memories ENABLE REPLICA TRIGGER memories_subscription_enqueue;
  ELSE
    ALTER TABLE public.memories DISABLE TRIGGER memories_subscription_enqueue;
  END IF;
END;
$$;
