-- Use a transaction-local JSON namespace context for RLS while accepting
-- the legacy comma-separated runtime format during rollout/rollback.
CREATE OR REPLACE FUNCTION app_allowed_namespaces()
RETURNS text[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text := current_setting('app.allowed_namespaces', true);
  parsed text[];
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN ARRAY[]::text[];
  END IF;

  IF left(btrim(raw), 1) = '[' THEN
    BEGIN
      SELECT COALESCE(array_agg(value), ARRAY[]::text[])
      INTO parsed
      FROM jsonb_array_elements_text(raw::jsonb) AS value;
      RETURN parsed;
    EXCEPTION WHEN others THEN
      -- Malformed JSON denies access instead of falling back and widening it.
      RETURN ARRAY[]::text[];
    END;
  END IF;

  RETURN string_to_array(raw, ',');
END;
$$;

GRANT EXECUTE ON FUNCTION app_allowed_namespaces() TO total_recall_app;

DROP POLICY IF EXISTS namespace_read ON memories;
DROP POLICY IF EXISTS namespace_insert ON memories;
DROP POLICY IF EXISTS namespace_update ON memories;

CREATE POLICY namespace_read ON memories FOR SELECT
  USING (namespace = ANY(app_allowed_namespaces()));

CREATE POLICY namespace_insert ON memories FOR INSERT
  WITH CHECK (namespace = ANY(app_allowed_namespaces()));

CREATE POLICY namespace_update ON memories FOR UPDATE
  USING (namespace = ANY(app_allowed_namespaces()));

DROP POLICY IF EXISTS namespace_read ON documents;
DROP POLICY IF EXISTS namespace_insert ON documents;
DROP POLICY IF EXISTS namespace_update ON documents;

CREATE POLICY namespace_read ON documents FOR SELECT
  USING (namespace = ANY(app_allowed_namespaces()));

CREATE POLICY namespace_insert ON documents FOR INSERT
  WITH CHECK (namespace = ANY(app_allowed_namespaces()));

CREATE POLICY namespace_update ON documents FOR UPDATE
  USING (namespace = ANY(app_allowed_namespaces()));
