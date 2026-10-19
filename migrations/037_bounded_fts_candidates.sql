-- A tightly bounded definer function lets PostgreSQL use memories_fts_idx without
-- weakening the memories RLS policy or marking PostgreSQL built-ins LEAKPROOF.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'total_recall_fts_owner') THEN
    CREATE ROLE total_recall_fts_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'total_recall_fts_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'total_recall_fts_owner exists with incompatible role attributes';
  ELSIF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS owned_role ON owned_role.oid = membership.roleid
    WHERE owned_role.rolname = 'total_recall_fts_owner'
  ) THEN
    RAISE EXCEPTION 'total_recall_fts_owner must not be granted to another role';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO total_recall_fts_owner;
GRANT SELECT ON TABLE public.memories, public.api_keys, public.memory_consolidation_memberships
  TO total_recall_fts_owner;
GRANT EXECUTE ON FUNCTION public.app_current_key_id(), public.app_allowed_namespaces()
  TO total_recall_fts_owner;

CREATE OR REPLACE FUNCTION public.total_recall_fts_candidates_v1(
  p_query text,
  p_requested_namespaces text[],
  p_requested_access_ceiling text,
  p_limit integer,
  p_excluded_ids uuid[] DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_after timestamptz DEFAULT NULL,
  p_before timestamptz DEFAULT NULL,
  p_valid_at timestamptz DEFAULT NULL,
  p_services text[] DEFAULT NULL,
  p_event_types text[] DEFAULT NULL,
  p_event_after timestamptz DEFAULT NULL,
  p_event_before timestamptz DEFAULT NULL,
  p_event_before_exclusive boolean DEFAULT false,
  p_superseded boolean DEFAULT NULL
)
RETURNS TABLE(id uuid, text_score real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT m.id,
         pg_catalog.ts_rank_cd(
           pg_catalog.to_tsvector('english'::pg_catalog.regconfig, m.content),
           pg_catalog.plainto_tsquery('english'::pg_catalog.regconfig, p_query)
         ) AS text_score
  FROM public.memories AS m
  JOIN public.api_keys AS k
    ON k.id = public.app_current_key_id()::uuid
   AND k.enabled IS TRUE
   AND k.revoked_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at > pg_catalog.statement_timestamp())
   AND 'read' = ANY(k.permissions)
  WHERE p_query IS NOT NULL
    AND pg_catalog.btrim(p_query) <> ''
    AND pg_catalog.octet_length(p_query) <= 8192
    AND m.namespace = ANY(COALESCE(p_requested_namespaces, ARRAY[]::text[]))
    AND m.namespace = ANY(public.app_allowed_namespaces())
    AND m.namespace = ANY(k.namespaces)
    AND (m.namespace <> 'insights' OR (
      m.origin_namespace = ANY(public.app_allowed_namespaces())
      AND m.origin_namespace = ANY(k.namespaces)
    ))
    AND CASE COALESCE(m.access_level, 'normal')
          WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
        <= CASE p_requested_access_ceiling
          WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    AND CASE COALESCE(m.access_level, 'normal')
          WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
        <= CASE k.max_access_level
          WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    AND m.deleted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.statement_timestamp())
    AND (p_excluded_ids IS NULL OR NOT (m.id = ANY(p_excluded_ids)))
    AND (p_tags IS NULL OR pg_catalog.cardinality(p_tags) = 0 OR m.tags @> p_tags)
    AND (p_source IS NULL OR m.source = p_source)
    AND (p_after IS NULL OR m.created_at >= p_after)
    AND (p_before IS NULL OR m.created_at <= p_before)
    AND (p_valid_at IS NULL OR (
      m.valid_from <= p_valid_at AND (m.valid_to IS NULL OR p_valid_at < m.valid_to)
    ))
    AND (
      (p_valid_at IS NULL AND m.consolidated_into_id IS NULL)
      OR (p_valid_at IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.memory_consolidation_memberships AS cm
        WHERE cm.member_id = m.id
          AND cm.consolidated_at <= p_valid_at
          AND (cm.deconsolidated_at IS NULL OR p_valid_at < cm.deconsolidated_at)
      ))
    )
    AND (p_services IS NULL OR pg_catalog.cardinality(p_services) = 0 OR m.metadata->>'service' = ANY(p_services))
    AND (p_event_types IS NULL OR pg_catalog.cardinality(p_event_types) = 0 OR m.metadata->>'event_type' = ANY(p_event_types))
    AND (p_event_after IS NULL OR m.event_at >= p_event_after)
    AND (p_event_before IS NULL OR
      (p_event_before_exclusive AND m.event_at < p_event_before) OR
      (NOT p_event_before_exclusive AND m.event_at <= p_event_before))
    AND (p_superseded IS NULL OR (m.superseded_at IS NOT NULL) = p_superseded)
    AND pg_catalog.to_tsvector('english'::pg_catalog.regconfig, m.content)
        @@ pg_catalog.plainto_tsquery('english'::pg_catalog.regconfig, p_query)
  ORDER BY text_score DESC, m.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 100)
$function$;

REVOKE ALL ON FUNCTION public.total_recall_fts_candidates_v1(
  text, text[], text, integer, uuid[], text[], text, timestamptz, timestamptz,
  timestamptz, text[], text[], timestamptz, timestamptz, boolean, boolean
) FROM PUBLIC;
ALTER FUNCTION public.total_recall_fts_candidates_v1(
  text, text[], text, integer, uuid[], text[], text, timestamptz, timestamptz,
  timestamptz, text[], text[], timestamptz, timestamptz, boolean, boolean
) OWNER TO total_recall_fts_owner;
GRANT EXECUTE ON FUNCTION public.total_recall_fts_candidates_v1(
  text, text[], text, integer, uuid[], text[], text, timestamptz, timestamptz,
  timestamptz, text[], text[], timestamptz, timestamptz, boolean, boolean
) TO total_recall_app;
