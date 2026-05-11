CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'llm',
  model TEXT,
  runtime TEXT,
  parent_agent_id UUID REFERENCES agents(id),
  api_key_id UUID REFERENCES api_keys(id),
  metadata JSONB DEFAULT '{}',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id TEXT;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE TABLE IF NOT EXISTS recall_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT,
  agent_id UUID REFERENCES agents(id),
  client_id TEXT,
  query_text TEXT NOT NULL,
  memory_ids UUID[],
  result_count INTEGER DEFAULT 0,
  scores JSONB DEFAULT '[]',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_recall_traces_agent ON recall_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_recall_traces_session ON recall_traces(session_id);
CREATE INDEX IF NOT EXISTS idx_recall_traces_created ON recall_traces(created_at DESC);
