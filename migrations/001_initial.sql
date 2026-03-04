CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(768),
  source TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'shared',
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  access_level TEXT DEFAULT 'normal',
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_count INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 256);

CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING gin (tags);
CREATE INDEX IF NOT EXISTS memories_ns_created_idx ON memories (namespace, created_at DESC);
CREATE INDEX IF NOT EXISTS memories_source_idx ON memories (source);
CREATE INDEX IF NOT EXISTS memories_client_idx ON memories (client_id);
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING gin (to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  namespaces TEXT[] NOT NULL DEFAULT '{shared}',
  permissions TEXT[] NOT NULL DEFAULT '{read,write}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  enabled BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
