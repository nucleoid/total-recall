CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,
  namespace TEXT,
  memory_id UUID,
  query_text TEXT,
  result_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX audit_log_client_idx ON audit_log (client_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Grant to app role
GRANT INSERT, SELECT ON audit_log TO total_recall_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO total_recall_app;
