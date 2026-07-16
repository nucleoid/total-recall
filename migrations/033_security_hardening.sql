-- Durable API-key expiry, quotas, recall provenance, and structured auditing.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from UUID REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS requests_per_minute INTEGER;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS requests_per_day INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_rotated_from_fkey' AND conrelid = 'api_keys'::regclass) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rotated_from_fkey
      FOREIGN KEY (rotated_from) REFERENCES api_keys(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_rpm_nonnegative' AND conrelid = 'api_keys'::regclass) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rpm_nonnegative CHECK (requests_per_minute IS NULL OR requests_per_minute >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_daily_nonnegative' AND conrelid = 'api_keys'::regclass) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_daily_nonnegative CHECK (requests_per_day IS NULL OR requests_per_day >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS api_keys_expires_at_idx ON api_keys (expires_at) WHERE enabled = true AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_rotated_from_idx ON api_keys (rotated_from) WHERE rotated_from IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_key_minute_usage (
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (api_key_id, window_start),
  CHECK (window_start = (date_trunc('minute', window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
);

CREATE TABLE IF NOT EXISTS api_key_daily_usage (
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (api_key_id, window_start)
);

CREATE INDEX IF NOT EXISTS api_key_minute_usage_window_idx ON api_key_minute_usage (window_start);
CREATE INDEX IF NOT EXISTS api_key_daily_usage_window_idx ON api_key_daily_usage (window_start);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_minute_usage TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_daily_usage TO total_recall_app;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS resource_type TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS resource_id TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details JSONB;
UPDATE audit_log SET details = '{}'::jsonb WHERE details IS NULL;
ALTER TABLE audit_log ALTER COLUMN details SET DEFAULT '{}'::jsonb;
ALTER TABLE audit_log ALTER COLUMN details SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_details_object' AND conrelid = 'audit_log'::regclass) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_details_object CHECK (jsonb_typeof(details) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log (resource_type, resource_id, created_at DESC);

-- Audit records are always private to the credential that produced them. An
-- admin credential may inspect its own records, never another key's records.
DROP POLICY IF EXISTS audit_log_key_select ON audit_log;
CREATE POLICY audit_log_key_select ON audit_log FOR SELECT
  USING (client_id = app_current_key_id());

-- A visible memory may have been written by another tenant into a shared
-- namespace. Permit reading only that memory's origin agent so callers can
-- receive verifiable provenance without exposing key identifiers.
DROP POLICY IF EXISTS agents_key_select ON agents;
CREATE POLICY agents_key_select ON agents FOR SELECT
  USING (
    api_key_id = app_current_key_id()::uuid
    OR EXISTS (SELECT 1 FROM memories m WHERE m.agent_id = agents.id)
  );
