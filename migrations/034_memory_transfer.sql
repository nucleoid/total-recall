-- Memory-only export/import feed identity and tenant-local merge keys (#64).
-- Stop every source-key writer before applying this mixed-version migration.

CREATE TABLE IF NOT EXISTS public.instance_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO public.instance_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

GRANT SELECT ON public.instance_settings TO total_recall_app;

-- Migration 002 created this implicit global constraint. All source-key writers
-- deployed with this migration use the composite conflict target below.
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_source_key_key;
DROP INDEX IF EXISTS public.memories_source_key_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.memories'::regclass
      AND conname = 'memories_client_source_key_key'
  ) THEN
    ALTER TABLE public.memories
      ADD CONSTRAINT memories_client_source_key_key UNIQUE (client_id, source_key);
  END IF;
END $$;

-- Content-free identity classification used before destination embedding. This
-- function may see through memory RLS, but returns only none/visible/denied and
-- can inspect identities owned by the transaction-local API key only.
CREATE OR REPLACE FUNCTION public.app_transfer_source_key_access(
  p_source_key TEXT,
  p_namespaces TEXT[],
  p_max_access_level TEXT,
  p_origin_instance_id UUID,
  p_origin_memory_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  memory_namespace TEXT;
  memory_access_level TEXT;
  memory_source_key TEXT;
  local_instance_id UUID;
  origin_match BOOLEAN := false;
BEGIN
  IF public.app_current_key_id() IS NULL OR p_source_key IS NULL THEN
    RETURN 'denied';
  END IF;

  SELECT instance_id INTO local_instance_id
  FROM public.instance_settings WHERE singleton = true;

  -- A feed returning to its source instance resolves the exact original row,
  -- including a row whose source_key is still NULL. The portable derived key
  -- is recomputed here without mutating that source row.
  IF local_instance_id = p_origin_instance_id THEN
    SELECT m.namespace, COALESCE(m.access_level, 'normal'), m.source_key
      INTO memory_namespace, memory_access_level, memory_source_key
    FROM public.memories m
    WHERE m.id = p_origin_memory_id
    LIMIT 1;

    IF FOUND THEN
      origin_match := memory_source_key = p_source_key OR (
        memory_source_key IS NULL AND p_source_key = 'total-recall-transfer:v1:' || encode(digest(
          convert_to(local_instance_id::TEXT, 'UTF8') || decode('00', 'hex') || convert_to(p_origin_memory_id::TEXT, 'UTF8'),
          'sha256'
        ), 'hex')
      );
      IF origin_match THEN
        IF NOT (memory_namespace = ANY(COALESCE(p_namespaces, ARRAY[]::TEXT[]))) THEN RETURN 'denied'; END IF;
        IF CASE memory_access_level
             WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3
           END > CASE p_max_access_level
             WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1
           END THEN RETURN 'denied'; END IF;
        RETURN 'origin';
      END IF;
    END IF;
  END IF;

  SELECT m.namespace, COALESCE(m.access_level, 'normal'), m.source_key
    INTO memory_namespace, memory_access_level, memory_source_key
  FROM public.memories m
  WHERE m.client_id = public.app_current_key_id()
    AND m.source_key = p_source_key
  LIMIT 1;

  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF NOT (memory_namespace = ANY(COALESCE(p_namespaces, ARRAY[]::TEXT[]))) THEN RETURN 'denied'; END IF;
  IF CASE memory_access_level
       WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3
     END > CASE p_max_access_level
       WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1
     END THEN RETURN 'denied'; END IF;
  RETURN 'visible';
END;
$$;

REVOKE ALL ON FUNCTION public.app_transfer_source_key_access(TEXT, TEXT[], TEXT, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_transfer_source_key_access(TEXT, TEXT[], TEXT, UUID, UUID) TO total_recall_app;
