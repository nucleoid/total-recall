ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_access_level TEXT;

UPDATE api_keys
SET max_access_level = 'secret'
WHERE max_access_level IS NULL;

ALTER TABLE api_keys ALTER COLUMN max_access_level SET NOT NULL;
ALTER TABLE api_keys ALTER COLUMN max_access_level SET DEFAULT 'normal';

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_max_access_level_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_max_access_level_check
  CHECK (max_access_level IN ('normal', 'sensitive', 'secret'));

UPDATE memories
SET access_level = COALESCE(access_level, 'normal')
WHERE access_level IS NULL;

ALTER TABLE memories ALTER COLUMN access_level SET DEFAULT 'normal';

ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_access_level_check;
ALTER TABLE memories ADD CONSTRAINT memories_access_level_check
  CHECK (access_level IN ('normal', 'sensitive', 'secret')) NOT VALID;

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_count
  FROM memories
  WHERE access_level IS NOT NULL
    AND access_level NOT IN ('normal', 'sensitive', 'secret');

  IF invalid_count = 0 THEN
    ALTER TABLE memories VALIDATE CONSTRAINT memories_access_level_check;
  ELSE
    RAISE NOTICE 'memories_access_level_check left NOT VALID: % existing memories have invalid access_level values and are hidden by application reads until remediated', invalid_count;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS memories_namespace_access_created_idx
  ON memories (namespace, access_level, created_at DESC);
