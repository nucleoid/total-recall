-- Shared connector foundation for source-scoped media and private life activity.
-- Deploy with every connector and rollup worker stopped. Existing unowned
-- credential/state rows intentionally become inaccessible until an operator
-- assigns them to the correct API key; ownership must never be guessed.

-- Media events gain an explicit source and a non-null provider/fallback event
-- key. The backfill preserves the old tuple identity before replacing it.
ALTER TABLE public.media_events
  ADD COLUMN IF NOT EXISTS source_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'media';

UPDATE public.media_events
SET source_id = metadata->>'server_id'
WHERE service = 'plex'
  AND NULLIF(btrim(metadata->>'server_id'), '') IS NOT NULL;

UPDATE public.media_events
SET event_key = 'legacy:v1:' || public.media_event_effective_identity(
  service_id, event_type, title, artist, album, show,
  season, episode, year, duration_ms
) || ':at:' || played_at::text
WHERE event_key IS NULL;

ALTER TABLE public.media_events ALTER COLUMN event_key SET NOT NULL;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.media_events'::regclass
      AND c.contype = 'u'
      AND c.conname IN (
        'media_events_client_service_identity_key',
        'media_events_service_service_id_played_at_key'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.media_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS public.media_events_effective_identity_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS media_events_source_event_key_uidx
  ON public.media_events (client_id, service, source_id, event_key)
  WHERE client_id IS NOT NULL;
-- Compatibility arbiter for old connectors and the migration backfill. Unlike
-- the replaced legacy rule, source_id prevents cross-account collisions.
CREATE UNIQUE INDEX IF NOT EXISTS media_events_source_effective_identity_uidx
  ON public.media_events (
    client_id, service, source_id,
    public.media_event_effective_identity(
      service_id, event_type, title, artist, album, show,
      season, episode, year, duration_ms
    ),
    played_at
  ) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_events_source_idx
  ON public.media_events (client_id, service, source_id, played_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_events'::regclass
      AND conname = 'media_events_source_id_nonblank'
  ) THEN
    ALTER TABLE public.media_events ADD CONSTRAINT media_events_source_id_nonblank
      CHECK (btrim(source_id) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_events'::regclass
      AND conname = 'media_events_event_key_nonblank'
  ) THEN
    ALTER TABLE public.media_events ADD CONSTRAINT media_events_event_key_nonblank
      CHECK (btrim(event_key) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_events'::regclass
      AND conname = 'media_events_namespace_media'
  ) THEN
    ALTER TABLE public.media_events ADD CONSTRAINT media_events_namespace_media
      CHECK (namespace = 'media');
  END IF;
END $$;

-- Non-media activity is deliberately separate from media_events and its
-- renderer. observed_at records ingestion/measurement time independently of
-- the provider occurrence time and its precision/time zone.
CREATE TABLE IF NOT EXISTS public.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector text NOT NULL,
  source_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  time_precision text NOT NULL DEFAULT 'instant',
  source_timezone text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  namespace text NOT NULL DEFAULT 'activity',
  client_id uuid NOT NULL REFERENCES public.api_keys(id),
  agent_id uuid REFERENCES public.agents(id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT activity_events_source_id_nonblank CHECK (btrim(source_id) <> ''),
  CONSTRAINT activity_events_event_key_nonblank CHECK (btrim(event_key) <> ''),
  CONSTRAINT activity_events_connector_nonblank CHECK (btrim(connector) <> ''),
  CONSTRAINT activity_events_type_nonblank CHECK (btrim(event_type) <> ''),
  CONSTRAINT activity_events_title_nonblank CHECK (btrim(title) <> ''),
  CONSTRAINT activity_events_namespace_nonblank CHECK (btrim(namespace) <> ''),
  CONSTRAINT activity_events_precision_check CHECK (time_precision IN ('instant', 'minute', 'day', 'aggregate')),
  CONSTRAINT activity_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT activity_events_source_event_key UNIQUE (client_id, connector, source_id, event_key)
);

CREATE INDEX IF NOT EXISTS activity_events_occurred_at_idx
  ON public.activity_events (client_id, namespace, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_events_source_idx
  ON public.activity_events (client_id, connector, source_id, occurred_at DESC);

-- Credentials and cursors are source scoped and owner/namespace protected.
-- Legacy rows remain nullable only to permit a non-destructive upgrade. New
-- app-role writes are constrained by RLS to a real current key.
ALTER TABLE public.connector_credentials
  ADD COLUMN IF NOT EXISTS source_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'media',
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.api_keys(id);
ALTER TABLE public.connector_credentials DROP CONSTRAINT IF EXISTS connector_credentials_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS connector_credentials_owner_source_uidx
  ON public.connector_credentials (client_id, namespace, service, source_id) NULLS NOT DISTINCT;

ALTER TABLE public.connector_sync_state
  ADD COLUMN IF NOT EXISTS source_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'media',
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.api_keys(id);
ALTER TABLE public.connector_sync_state DROP CONSTRAINT IF EXISTS connector_sync_state_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS connector_sync_state_owner_source_uidx
  ON public.connector_sync_state (client_id, namespace, service, source_id) NULLS NOT DISTINCT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.connector_credentials'::regclass AND conname='connector_credentials_source_nonblank') THEN
    ALTER TABLE public.connector_credentials ADD CONSTRAINT connector_credentials_source_nonblank CHECK (btrim(source_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.connector_credentials'::regclass AND conname='connector_credentials_namespace_nonblank') THEN
    ALTER TABLE public.connector_credentials ADD CONSTRAINT connector_credentials_namespace_nonblank CHECK (btrim(namespace) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.connector_sync_state'::regclass AND conname='connector_sync_state_source_nonblank') THEN
    ALTER TABLE public.connector_sync_state ADD CONSTRAINT connector_sync_state_source_nonblank CHECK (btrim(source_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.connector_sync_state'::regclass AND conname='connector_sync_state_namespace_nonblank') THEN
    ALTER TABLE public.connector_sync_state ADD CONSTRAINT connector_sync_state_namespace_nonblank CHECK (btrim(namespace) <> '');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.activity_events TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connector_credentials TO total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connector_sync_state TO total_recall_app;

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_events_key_select ON public.media_events;
DROP POLICY IF EXISTS media_events_key_insert ON public.media_events;
DROP POLICY IF EXISTS media_events_key_update ON public.media_events;
CREATE POLICY media_events_owner_namespace_select ON public.media_events FOR SELECT
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY media_events_owner_namespace_insert ON public.media_events FOR INSERT
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY media_events_owner_namespace_update ON public.media_events FOR UPDATE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));

CREATE POLICY activity_events_owner_namespace_select ON public.activity_events FOR SELECT
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY activity_events_owner_namespace_insert ON public.activity_events FOR INSERT
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY activity_events_owner_namespace_update ON public.activity_events FOR UPDATE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));

CREATE POLICY connector_credentials_owner_namespace_select ON public.connector_credentials FOR SELECT
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_credentials_owner_namespace_insert ON public.connector_credentials FOR INSERT
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_credentials_owner_namespace_update ON public.connector_credentials FOR UPDATE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_credentials_owner_namespace_delete ON public.connector_credentials FOR DELETE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));

CREATE POLICY connector_sync_state_owner_namespace_select ON public.connector_sync_state FOR SELECT
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_sync_state_owner_namespace_insert ON public.connector_sync_state FOR INSERT
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_sync_state_owner_namespace_update ON public.connector_sync_state FOR UPDATE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()))
  WITH CHECK (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
CREATE POLICY connector_sync_state_owner_namespace_delete ON public.connector_sync_state FOR DELETE
  USING (client_id = app_current_key_id()::uuid AND namespace = ANY(app_allowed_namespaces()));
