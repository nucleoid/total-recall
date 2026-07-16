-- Versioned memory-only transfer identity and tenant-local source keys (#64).
-- Stop all legacy source-key writers before applying this mixed-version-incompatible migration.

CREATE TABLE IF NOT EXISTS public.instance_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  instance_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
INSERT INTO public.instance_settings (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

GRANT SELECT ON public.instance_settings TO total_recall_app;

-- A preflight may need to distinguish an inaccessible row owned by this same
-- key without revealing its content, namespace, or existence separately from a
-- generic denial. This prevents provider egress before an inevitable unique
-- conflict. The function returns one aggregate boolean only.
CREATE OR REPLACE FUNCTION public.app_transfer_has_hidden_identity(source_keys text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memories m
    CROSS JOIN public.instance_settings settings
    JOIN public.api_keys k ON k.id::text = public.app_current_key_id()
    WHERE m.client_id = public.app_current_key_id()
      AND (
        m.source_key = ANY(source_keys)
        OR ('total-recall:v1:' || settings.instance_id::text || ':' || m.id::text) = ANY(source_keys)
      )
      AND (
        NOT (m.namespace = ANY(public.app_allowed_namespaces()))
        OR CASE COALESCE(m.access_level, 'normal')
             WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
           > CASE COALESCE(k.max_access_level, 'normal')
             WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
      )
  )
$$;
REVOKE ALL ON FUNCTION public.app_transfer_has_hidden_identity(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_transfer_has_hidden_identity(text[]) TO total_recall_app;

-- Import is its own explicit write capability. Keep the policy narrow enough
-- that transfer cannot create local agent/document relationships or unkeyed
-- rows, while allowing memory-only insight rows in an authorized namespace.
DROP POLICY IF EXISTS transfer_memory_insert ON public.memories;
CREATE POLICY transfer_memory_insert ON public.memories FOR INSERT WITH CHECK (
  public.app_current_key_has_permission('import')
  AND namespace = ANY(public.app_allowed_namespaces())
  AND client_id = public.app_current_key_id()
  AND source_key IS NOT NULL
  AND agent_id IS NULL
  AND document_id IS NULL
  AND (
    (namespace = 'insights' AND memory_kind = 'insight'
      AND origin_namespace = ANY(public.app_allowed_namespaces())
      AND insight_content_hash ~ '^[0-9a-f]{64}$')
    OR
    (namespace <> 'insights' AND memory_kind <> 'insight'
      AND origin_namespace IS NULL AND insight_content_hash IS NULL)
  )
);

-- Migration 002 created a column-level global UNIQUE constraint. Locate it by
-- shape rather than assuming PostgreSQL's generated constraint name.
DO $$
DECLARE constraint_name name;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = 'public.memories'::regclass
      AND c.contype = 'u'
      AND cardinality(c.conkey) = 1
      AND a.attname = 'source_key'
  LOOP
    EXECUTE format('ALTER TABLE public.memories DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS public.memories_client_source_key_uidx;
CREATE UNIQUE INDEX memories_client_source_key_uidx
  ON public.memories (client_id, source_key)
  WHERE source_key IS NOT NULL;

COMMENT ON TABLE public.instance_settings IS
  'Singleton portable identity used to derive stable transfer keys; never regenerate after deployment.';
COMMENT ON INDEX public.memories_client_source_key_uidx IS
  'Import/idempotency identity is local to the destination API key tenant.';
