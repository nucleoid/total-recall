-- Phase 1 of media integrations: structured event store + connector scaffolding.
-- See docs/agent-memory-guidelines.md for context on namespaces and provenance.

-- Structured viewing/listening events from third-party services.
CREATE TABLE IF NOT EXISTS media_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service      TEXT NOT NULL,        -- spotify, plex, ytmusic, netflix, neon
  service_id   TEXT,                 -- service's own item id (track URI, ratingKey, etc.)
  event_type   TEXT NOT NULL,        -- play, scrobble, watch, complete
  title        TEXT NOT NULL,
  artist       TEXT,
  album        TEXT,
  show         TEXT,
  season       INTEGER,
  episode      INTEGER,
  year         INTEGER,
  genres       TEXT[] DEFAULT '{}',
  duration_ms  INTEGER,
  played_ms    INTEGER,
  completed    BOOLEAN,
  played_at    TIMESTAMPTZ NOT NULL,
  metadata     JSONB DEFAULT '{}',   -- service-specific extras
  client_id    UUID REFERENCES api_keys(id),
  agent_id     UUID REFERENCES agents(id),
  memory_id    UUID REFERENCES memories(id) ON DELETE SET NULL,  -- back-ref to rolled-up summary memory
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service, service_id, played_at)
);

CREATE INDEX IF NOT EXISTS idx_media_events_played_at ON media_events (played_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_events_service ON media_events (service);
CREATE INDEX IF NOT EXISTS idx_media_events_rollup_pending ON media_events (played_at) WHERE memory_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_events_artist ON media_events (artist) WHERE artist IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_events_show ON media_events (show) WHERE show IS NOT NULL;

-- Per-service credentials (OAuth tokens, API keys, refresh tokens, account ids).
-- Stored unencrypted for now; relies on DB-level access controls. Add app-level
-- encryption before exposing this DB beyond a single trusted host.
CREATE TABLE IF NOT EXISTS connector_credentials (
  service     TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-connector sync state (last successful pull, cursors, etc.).
CREATE TABLE IF NOT EXISTS connector_sync_state (
  service        TEXT PRIMARY KEY,
  last_sync_at   TIMESTAMPTZ,
  last_event_at  TIMESTAMPTZ,
  cursor         TEXT,
  metadata       JSONB DEFAULT '{}',
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Grants for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON media_events            TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_credentials   TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_sync_state    TO total_recall_app;
