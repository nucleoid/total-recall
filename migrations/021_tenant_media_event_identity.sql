-- Scope media event idempotency to the authenticated owner. Historical rows
-- with NULL client_id remain private to follow-up audit because PostgreSQL
-- treats NULL values as distinct in unique constraints.

DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT c.conname
    INTO old_constraint
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'media_events'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY u.ord)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
    ) = ARRAY['service', 'service_id', 'played_at'];

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.media_events DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'media_events'
      AND c.conname = 'media_events_client_service_identity_key'
  ) THEN
    ALTER TABLE public.media_events
      ADD CONSTRAINT media_events_client_service_identity_key
      UNIQUE (client_id, service, service_id, played_at);
  END IF;
END $$;
