-- Keep per-snapshot membership out of the heavily indexed memories table so an
-- unchanged archive refresh does not rewrite embeddings or search indexes.
CREATE TABLE public.archive_sync_snapshot_memberships (
  sync_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  membership_id UUID NOT NULL,
  source_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (sync_key_id, archive_id, membership_id, source_key),
  CHECK (archive_id ~ '^[-a-zA-Z0-9_:]{1,128}$'),
  CHECK (char_length(source_key) BETWEEN 1 AND 512)
);

ALTER TABLE public.archive_sync_snapshot_memberships ENABLE ROW LEVEL SECURITY;

-- Old CLIs identify missing chunks by the operational snapshot_id stored on
-- memories. Membership-aware refreshes intentionally leave that field unchanged
-- on equivalent rows. Guard both the state transition and the soft-delete path
-- in the database so a stale receiver/finalizer cannot prune those rows.
CREATE FUNCTION public.guard_archive_membership_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE prior_membership TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.metadata->>'membership_id' IS NULL THEN
      RAISE EXCEPTION 'archive_sync.membership_schema_mismatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  prior_membership := OLD.metadata->>'membership_id';
  IF NEW.metadata->>'copy_in_progress' = 'true'
     AND NEW.metadata->'pending_finalization' IS NULL
     AND (NEW.metadata->>'membership_id' IS NULL
       OR (prior_membership IS NOT NULL AND NEW.metadata->>'membership_id' = prior_membership)) THEN
    RAISE EXCEPTION 'archive_sync.membership_schema_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF prior_membership IS NULL THEN RETURN NEW; END IF;
  IF OLD.metadata->'pending_finalization' IS NULL
     AND NEW.metadata->'pending_finalization' IS NOT NULL
     AND NEW.metadata->'pending_finalization'->>'membership_id'
       IS DISTINCT FROM NEW.metadata->>'membership_id' THEN
    RAISE EXCEPTION 'archive_sync.membership_schema_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.metadata->'pending_finalization'->>'membership_id' IS NOT NULL
     AND NEW.metadata->>'copy_in_progress' = 'false'
     AND NEW.metadata->>'membership_id'
       IS DISTINCT FROM OLD.metadata->'pending_finalization'->>'membership_id' THEN
    RAISE EXCEPTION 'archive_sync.membership_schema_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_archive_membership_state_insert
BEFORE INSERT ON public.memories
FOR EACH ROW WHEN (NEW.namespace = 'my-life' AND NEW.source = 'my-life:sync-state')
EXECUTE FUNCTION public.guard_archive_membership_state();
CREATE TRIGGER guard_archive_membership_state
BEFORE UPDATE OF metadata ON public.memories
FOR EACH ROW WHEN (OLD.namespace = 'my-life' AND OLD.source = 'my-life:sync-state')
EXECUTE FUNCTION public.guard_archive_membership_state();

CREATE FUNCTION public.guard_archive_membership_prune() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE pending_membership TEXT;
BEGIN
  SELECT state.metadata->'pending_finalization'->>'membership_id'
    INTO pending_membership
  FROM public.memories state
  WHERE state.client_id = OLD.client_id
    AND state.source_key = 'mylife:state:' || (OLD.metadata->'my_life'->>'archive_id')
    AND state.namespace = 'my-life' AND state.source = 'my-life:sync-state'
    AND state.access_level = 'sensitive' AND state.deleted_at IS NULL;
  IF pending_membership IS NOT NULL
     AND current_setting('app.archive_membership_finalizer', true)
       IS DISTINCT FROM pending_membership THEN
    RAISE EXCEPTION 'archive_sync.membership_finalizer_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_archive_membership_prune
BEFORE UPDATE OF deleted_at ON public.memories
FOR EACH ROW WHEN (OLD.namespace = 'my-life' AND OLD.source = 'my-life'
  AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  AND OLD.client_id = public.app_current_key_id())
EXECUTE FUNCTION public.guard_archive_membership_prune();

-- This repeats the operator CLI's exact identity boundary at the table. A
-- personal reader that also has my-life access cannot mutate sync membership.
CREATE POLICY archive_sync_membership_select ON public.archive_sync_snapshot_memberships
FOR SELECT USING (
  sync_key_id::text = public.app_current_key_id()
  AND 'my-life' = ANY(public.app_allowed_namespaces())
  AND EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE k.id = sync_key_id
      AND k.enabled
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
      AND k.namespaces = ARRAY['my-life']::text[]
      AND k.permissions @> ARRAY['read','write','import']::text[]
      AND k.max_access_level = 'sensitive'
  )
);
CREATE POLICY archive_sync_membership_insert ON public.archive_sync_snapshot_memberships
FOR INSERT WITH CHECK (
  sync_key_id::text = public.app_current_key_id()
  AND 'my-life' = ANY(public.app_allowed_namespaces())
  AND EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE k.id = sync_key_id
      AND k.enabled
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
      AND k.namespaces = ARRAY['my-life']::text[]
      AND k.permissions @> ARRAY['read','write','import']::text[]
      AND k.max_access_level = 'sensitive'
  )
);
CREATE POLICY archive_sync_membership_delete ON public.archive_sync_snapshot_memberships
FOR DELETE USING (
  sync_key_id::text = public.app_current_key_id()
  AND 'my-life' = ANY(public.app_allowed_namespaces())
  AND EXISTS (
    SELECT 1 FROM public.api_keys k
    WHERE k.id = sync_key_id
      AND k.enabled
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
      AND k.namespaces = ARRAY['my-life']::text[]
      AND k.permissions @> ARRAY['read','write','import']::text[]
      AND k.max_access_level = 'sensitive'
  )
);

GRANT SELECT, INSERT, DELETE ON public.archive_sync_snapshot_memberships TO total_recall_app;

-- Seed one baseline generation from the last completed archive state. Include
-- rows written by a later incomplete copy so its partial inserts cannot evade
-- the next verified reconciliation. This writes only the narrow side table.
WITH raw_states AS MATERIALIZED (
  SELECT state.id state_id,k.id sync_key_id,
    COALESCE(state.metadata->'manifest'->>'archive_id',state.metadata->'started_manifest'->>'archive_id') archive_id,
    gen_random_uuid() membership_id
  FROM public.memories state JOIN public.api_keys k ON k.id::text=state.client_id
  WHERE state.namespace='my-life' AND state.source='my-life:sync-state'
    AND state.access_level='sensitive' AND state.deleted_at IS NULL
    AND k.namespaces=ARRAY['my-life']::text[]
    AND k.permissions @> ARRAY['read','write','import']::text[] AND k.max_access_level='sensitive'
), states AS MATERIALIZED (
  SELECT * FROM raw_states WHERE archive_id ~ '^[-a-zA-Z0-9_:]{1,128}$'
), linked AS (
  UPDATE public.memories state SET metadata=jsonb_set(state.metadata,'{membership_id}',to_jsonb(states.membership_id::text),true)
  FROM states WHERE state.id=states.state_id
  RETURNING states.sync_key_id,states.archive_id,states.membership_id
), baseline AS (
  INSERT INTO public.archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
  SELECT state.sync_key_id,state.archive_id,state.membership_id,memory.source_key
  FROM linked state JOIN public.memories memory
    ON memory.client_id=state.sync_key_id::text
   AND memory.namespace='my-life' AND memory.source='my-life'
   AND memory.metadata->'my_life'->>'archive_id'=state.archive_id
  WHERE memory.access_level IN ('normal','sensitive') AND memory.deleted_at IS NULL
    AND memory.superseded_at IS NULL AND memory.consolidated_into_id IS NULL
    AND (memory.expires_at IS NULL OR memory.expires_at>statement_timestamp())
    AND memory.source_key IS NOT NULL AND char_length(memory.source_key) BETWEEN 1 AND 512
  ON CONFLICT DO NOTHING RETURNING 1
)
SELECT count(*) FROM baseline;
