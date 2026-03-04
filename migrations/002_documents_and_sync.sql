-- Documents table for chunked document storage
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  namespace TEXT NOT NULL DEFAULT 'shared',
  tags TEXT[] DEFAULT '{}',
  chunk_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync state for file watcher
CREATE TABLE IF NOT EXISTS sync_state (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  last_synced TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns to memories table
ALTER TABLE memories ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS chunk_index INT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS memories_document_id_idx ON memories (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS memories_source_key_idx ON memories (source_key);
