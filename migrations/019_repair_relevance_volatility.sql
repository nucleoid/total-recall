-- Repair databases where the legacy calculate_relevance definition was already
-- recorded as migrated while still incorrectly marked IMMUTABLE. ALTER changes
-- only catalog metadata, leaving the existing function body unchanged.
DO $$
DECLARE
  overload_count INTEGER;
  target_count INTEGER;
  existing_owner TEXT;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE p.oid = to_regprocedure(
             'public.calculate_relevance(double precision,double precision,timestamp with time zone,integer)'
           )
         ),
         MAX(pg_get_userbyid(p.proowner)) FILTER (
           WHERE p.oid = to_regprocedure(
             'public.calculate_relevance(double precision,double precision,timestamp with time zone,integer)'
           )
         )
  INTO overload_count, target_count, existing_owner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'calculate_relevance';

  IF target_count <> 1 THEN
    RAISE EXCEPTION
      'Expected the canonical public.calculate_relevance(double precision,double precision,timestamp with time zone,integer) function before volatility repair';
  END IF;

  IF overload_count <> 1 THEN
    RAISE EXCEPTION
      'Detected % public.calculate_relevance overloads; remove unintended overloads before repairing the canonical signature',
      overload_count;
  END IF;

  IF existing_owner <> current_user THEN
    RAISE EXCEPTION
      'Cannot alter public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER): existing function is owned by %. As the function owner or a superuser, run ALTER FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER) OWNER TO %, or drop and recreate the canonical function with that owner, before migration 019. Do not grant total_recall_app DDL privileges.',
      existing_owner,
      current_user
      USING ERRCODE = '42501';
  END IF;
END;
$$;

ALTER FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER) STABLE;

-- Preserve runtime access if function privileges were hardened independently.
GRANT EXECUTE ON FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER) TO total_recall_app;
