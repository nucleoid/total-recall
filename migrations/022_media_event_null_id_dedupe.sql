-- Database-owned idempotency for media events whose provider ID is absent.
-- This migration deliberately aborts on historical collisions. Reconcile only
-- through the separately invoked preview/approval repair after a verified backup.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.media_event_effective_identity(
  p_service_id text,
  p_event_type text,
  p_title text,
  p_artist text,
  p_album text,
  p_show text,
  p_season integer,
  p_episode integer,
  p_year integer,
  p_duration_ms integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path TO pg_catalog, public
AS $function$
  SELECT CASE
    WHEN NULLIF(pg_catalog.btrim(p_service_id), '') IS NOT NULL
      THEN 'id:' || p_service_id
    ELSE 'fallback:v1:' || pg_catalog.encode(
      public.digest(
        pg_catalog.convert_to(
          'v1;' ||
          CASE WHEN p_event_type IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_event_type, 'UTF8'))::text || ':' || p_event_type || ';' END ||
          CASE WHEN p_title      IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_title,      'UTF8'))::text || ':' || p_title      || ';' END ||
          CASE WHEN p_artist     IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_artist,     'UTF8'))::text || ':' || p_artist     || ';' END ||
          CASE WHEN p_album      IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_album,      'UTF8'))::text || ':' || p_album      || ';' END ||
          CASE WHEN p_show       IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_show,       'UTF8'))::text || ':' || p_show       || ';' END ||
          CASE WHEN p_season     IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_season::text,     'UTF8'))::text || ':' || p_season::text     || ';' END ||
          CASE WHEN p_episode    IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_episode::text,    'UTF8'))::text || ':' || p_episode::text    || ';' END ||
          CASE WHEN p_year       IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_year::text,       'UTF8'))::text || ':' || p_year::text       || ';' END ||
          CASE WHEN p_duration_ms IS NULL THEN 'N;' ELSE 'V' || pg_catalog.octet_length(pg_catalog.convert_to(p_duration_ms::text, 'UTF8'))::text || ':' || p_duration_ms::text || ';' END,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  END
$function$;

DO $preflight$
DECLARE
  duplicate_groups bigint;
  duplicate_rows bigint;
BEGIN
  WITH groups AS (
    SELECT count(*) AS group_size
    FROM public.media_events
    WHERE client_id IS NOT NULL
    GROUP BY client_id, service,
      public.media_event_effective_identity(
        service_id, event_type, title, artist, album, show,
        season, episode, year, duration_ms
      ),
      played_at
    HAVING count(*) > 1
  )
  SELECT count(*), COALESCE(sum(group_size), 0)
  INTO duplicate_groups, duplicate_rows
  FROM groups;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'media event effective identity preflight found % duplicate groups containing % rows; no rows changed. Run the documented preview and explicitly approved repair workflow',
      duplicate_groups, duplicate_rows;
  END IF;
END
$preflight$;

-- Migration 021 owns the tenant-local provider identity constraint required by
-- the #8 writer's direct conflict target. Preserve that constraint and add the
-- effective-identity rule alongside it. NULL client owners intentionally remain
-- outside both tenant uniqueness rules.
CREATE UNIQUE INDEX IF NOT EXISTS media_events_effective_identity_uidx
  ON public.media_events (
    client_id,
    service,
    public.media_event_effective_identity(
      service_id, event_type, title, artist, album, show,
      season, episode, year, duration_ms
    ),
    played_at
  )
  WHERE client_id IS NOT NULL;

GRANT EXECUTE ON FUNCTION public.media_event_effective_identity(
  text, text, text, text, text, text, integer, integer, integer, integer
) TO total_recall_app;
