-- Defense-in-depth tenant isolation for metadata/provenance tables.
-- The app sets app.current_key_id transaction-locally before running queries.
-- Missing key context evaluates to NULL and therefore hides all rows.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_api_key_name_unique ON agents (api_key_id, name);

GRANT SELECT, INSERT, UPDATE ON agents TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON recall_traces TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON audit_log TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON media_events TO total_recall_app;

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE recall_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_key_select ON agents FOR SELECT
  USING (api_key_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);

CREATE POLICY agents_key_insert ON agents FOR INSERT
  WITH CHECK (api_key_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);

CREATE POLICY agents_key_update ON agents FOR UPDATE
  USING (api_key_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid)
  WITH CHECK (api_key_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);

CREATE POLICY recall_traces_key_select ON recall_traces FOR SELECT
  USING (client_id = current_setting('app.current_key_id', true));

CREATE POLICY recall_traces_key_insert ON recall_traces FOR INSERT
  WITH CHECK (client_id = current_setting('app.current_key_id', true));

CREATE POLICY recall_traces_key_update ON recall_traces FOR UPDATE
  USING (client_id = current_setting('app.current_key_id', true))
  WITH CHECK (client_id = current_setting('app.current_key_id', true));

CREATE POLICY audit_log_key_select ON audit_log FOR SELECT
  USING (client_id = current_setting('app.current_key_id', true));

CREATE POLICY audit_log_key_insert ON audit_log FOR INSERT
  WITH CHECK (client_id = current_setting('app.current_key_id', true));

CREATE POLICY audit_log_key_update ON audit_log FOR UPDATE
  USING (client_id = current_setting('app.current_key_id', true))
  WITH CHECK (client_id = current_setting('app.current_key_id', true));

CREATE POLICY media_events_key_select ON media_events FOR SELECT
  USING (client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);

CREATE POLICY media_events_key_insert ON media_events FOR INSERT
  WITH CHECK (client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);

CREATE POLICY media_events_key_update ON media_events FOR UPDATE
  USING (client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid);
