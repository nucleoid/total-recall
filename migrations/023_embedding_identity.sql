ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_provider TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'embedding_identity_all_or_none'
      AND conrelid = 'memories'::regclass
  ) THEN
    ALTER TABLE memories
      ADD CONSTRAINT embedding_identity_all_or_none
      CHECK (
        (
          embedding_provider IS NULL
          AND embedding_model IS NULL
          AND embedding_dimensions IS NULL
        )
        OR
        (
          embedding IS NOT NULL
          AND embedding_provider IS NOT NULL
          AND embedding_provider <> ''
          AND embedding_model IS NOT NULL
          AND embedding_model <> ''
          AND embedding_dimensions IS NOT NULL
          AND embedding_dimensions > 0
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS memories_embedding_identity_idx
  ON memories (embedding_provider, embedding_model, embedding_dimensions, namespace)
  WHERE embedding_provider IS NOT NULL;
