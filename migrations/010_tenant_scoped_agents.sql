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

CREATE UNIQUE INDEX IF NOT EXISTS agents_api_key_name_owned_key
  ON agents (api_key_id, name)
  WHERE api_key_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_system_key
  ON agents (name)
  WHERE api_key_id IS NULL;

GRANT SELECT, INSERT, UPDATE ON agents TO total_recall_app;
GRANT SELECT, INSERT ON recall_traces TO total_recall_app;
