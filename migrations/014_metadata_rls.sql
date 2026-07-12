-- Defense-in-depth tenant isolation for metadata/provenance tables.
-- The app sets app.current_key_id transaction-locally before running queries.
-- Roll out with writers stopped: old runtimes using ON CONFLICT (name) are not
-- compatible with the composite agent key and must not run during this migration.
-- Missing key context evaluates to NULL and therefore hides all rows.

CREATE OR REPLACE FUNCTION app_current_key_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_key_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_current_key_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_key_is_admin', true), '') = 'true'
$$;

GRANT EXECUTE ON FUNCTION app_current_key_id() TO total_recall_app;
GRANT EXECUTE ON FUNCTION app_current_key_is_admin() TO total_recall_app;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_name_key;
DROP INDEX IF EXISTS idx_agents_api_key_name_unique;

GRANT SELECT, INSERT, UPDATE ON agents TO total_recall_app;
GRANT SELECT, INSERT ON recall_traces TO total_recall_app;
GRANT SELECT, INSERT ON audit_log TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON media_events TO total_recall_app;

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE recall_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agents_key_select ON agents;
DROP POLICY IF EXISTS agents_key_insert ON agents;
DROP POLICY IF EXISTS agents_key_update ON agents;
DROP POLICY IF EXISTS recall_traces_key_select ON recall_traces;
DROP POLICY IF EXISTS recall_traces_key_insert ON recall_traces;
DROP POLICY IF EXISTS audit_log_key_select ON audit_log;
DROP POLICY IF EXISTS audit_log_key_insert ON audit_log;
DROP POLICY IF EXISTS media_events_key_select ON media_events;
DROP POLICY IF EXISTS media_events_key_insert ON media_events;
DROP POLICY IF EXISTS media_events_key_update ON media_events;

CREATE POLICY agents_key_select ON agents FOR SELECT
  USING (app_current_key_is_admin() OR api_key_id = app_current_key_id()::uuid);

CREATE POLICY agents_key_insert ON agents FOR INSERT
  WITH CHECK (api_key_id = app_current_key_id()::uuid);

CREATE POLICY agents_key_update ON agents FOR UPDATE
  USING (api_key_id = app_current_key_id()::uuid)
  WITH CHECK (api_key_id = app_current_key_id()::uuid);

CREATE POLICY recall_traces_key_select ON recall_traces FOR SELECT
  USING (app_current_key_is_admin() OR client_id = app_current_key_id());

CREATE POLICY recall_traces_key_insert ON recall_traces FOR INSERT
  WITH CHECK (client_id = app_current_key_id());

CREATE POLICY audit_log_key_select ON audit_log FOR SELECT
  USING (app_current_key_is_admin() OR client_id = app_current_key_id());

CREATE POLICY audit_log_key_insert ON audit_log FOR INSERT
  WITH CHECK (client_id = app_current_key_id());

CREATE POLICY media_events_key_select ON media_events FOR SELECT
  USING (app_current_key_is_admin() OR client_id = app_current_key_id()::uuid);

CREATE POLICY media_events_key_insert ON media_events FOR INSERT
  WITH CHECK (client_id = app_current_key_id()::uuid);

CREATE POLICY media_events_key_update ON media_events FOR UPDATE
  USING (client_id = app_current_key_id()::uuid)
  WITH CHECK (client_id = app_current_key_id()::uuid);
