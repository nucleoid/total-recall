-- Create app role that the MCP server will use
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'total_recall_app') THEN
    CREATE ROLE total_recall_app LOGIN PASSWORD 'total_recall_app_dev';
  END IF;
END $$;

-- Grant necessary permissions
GRANT CONNECT ON DATABASE total_recall TO total_recall_app;
GRANT USAGE ON SCHEMA public TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON memories TO total_recall_app;
GRANT SELECT, INSERT, UPDATE ON documents TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_state TO total_recall_app;

-- Enable RLS (applies to non-owner roles by default)
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Policies for memories
CREATE POLICY namespace_read ON memories FOR SELECT
  USING (namespace = ANY(string_to_array(current_setting('app.allowed_namespaces', true), ',')));

CREATE POLICY namespace_insert ON memories FOR INSERT
  WITH CHECK (namespace = ANY(string_to_array(current_setting('app.allowed_namespaces', true), ',')));

CREATE POLICY namespace_update ON memories FOR UPDATE
  USING (namespace = ANY(string_to_array(current_setting('app.allowed_namespaces', true), ',')));

-- Policies for documents
CREATE POLICY namespace_read ON documents FOR SELECT
  USING (namespace = ANY(string_to_array(current_setting('app.allowed_namespaces', true), ',')));

CREATE POLICY namespace_insert ON documents FOR INSERT
  WITH CHECK (namespace = ANY(string_to_array(current_setting('app.allowed_namespaces', true), ',')));
