ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES api_keys(id),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_request_hash_format_chk'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_request_hash_format_chk
      CHECK (request_hash IS NULL OR request_hash ~ '^sha256:v1:[0-9a-f]{64}$');
  END IF;
END $$;

-- The namespace-scoped unique index is deliberately built by
-- `npm run index:document-idempotency`, outside the transaction-wrapped runner.
