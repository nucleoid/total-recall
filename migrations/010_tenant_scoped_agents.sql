-- Tenant-scoped agent identity for issue #7.
--
-- Roll out with old writers stopped, or deploy the new application build before
-- running this migration. Old runtimes use ON CONFLICT (api_key_id, name)
-- without the partial-index predicate and cannot infer the new owned-agent
-- arbiter after this migration has run.

DO $$
DECLARE
  unique_name_constraint TEXT;
BEGIN
  SELECT conname INTO unique_name_constraint
  FROM pg_constraint c
  WHERE c.conrelid = 'agents'::regclass
    AND contype = 'u'
    AND ARRAY(
      SELECT a.attname::TEXT
      FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = key.attnum
      ORDER BY key.ord
    ) = ARRAY['name']
  LIMIT 1;

  IF unique_name_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agents DROP CONSTRAINT %I', unique_name_constraint);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_agents_name;
DROP INDEX IF EXISTS idx_agents_api_key_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS agents_api_key_name_owned_key
  ON agents (api_key_id, name)
  WHERE api_key_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_system_key
  ON agents (name)
  WHERE api_key_id IS NULL;

CREATE OR REPLACE FUNCTION upsert_system_agent(
  p_name TEXT,
  p_type TEXT,
  p_model TEXT,
  p_runtime TEXT,
  p_metadata JSONB
)
RETURNS agents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  system_agent agents;
BEGIN
  INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
  VALUES (p_name, COALESCE(p_type, 'system'), p_model, p_runtime, NULL, NULL, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (name) WHERE api_key_id IS NULL DO UPDATE SET
    type = COALESCE(EXCLUDED.type, agents.type),
    model = COALESCE(EXCLUDED.model, agents.model),
    runtime = COALESCE(EXCLUDED.runtime, agents.runtime),
    metadata = agents.metadata || EXCLUDED.metadata,
    last_seen_at = NOW()
  RETURNING * INTO system_agent;

  RETURN system_agent;
END;
$$;

REVOKE ALL ON FUNCTION upsert_system_agent(TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON agents TO total_recall_app;
GRANT SELECT, INSERT ON recall_traces TO total_recall_app;
GRANT EXECUTE ON FUNCTION upsert_system_agent(TEXT, TEXT, TEXT, TEXT, JSONB) TO total_recall_app;
