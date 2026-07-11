ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS relevance_score FLOAT DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS decay_rate FLOAT DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ;

UPDATE public.memories
SET relevance_score = 1.0
WHERE relevance_score IS NULL;

UPDATE public.memories
SET decay_rate = 0.01
WHERE decay_rate IS NULL;

ALTER TABLE public.memories
  ALTER COLUMN last_boosted_at SET DEFAULT NOW();

DO $$
DECLARE
  existing_owner TEXT;
BEGIN
  SELECT pg_get_userbyid(p.proowner)
  INTO existing_owner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'calculate_relevance'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_relevance_score double precision, p_decay_rate double precision, p_accessed_at timestamp with time zone, p_access_count integer';

  IF existing_owner IS NOT NULL AND existing_owner <> current_user THEN
    RAISE EXCEPTION
      'Cannot replace public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER): existing function is owned by %. Run ALTER FUNCTION public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER) OWNER TO % or DROP FUNCTION before migration 007. Do not grant total_recall_app DDL privileges.',
      existing_owner,
      current_user
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_relevance(
  p_relevance_score FLOAT,
  p_decay_rate FLOAT,
  p_accessed_at TIMESTAMPTZ,
  p_access_count INTEGER
) RETURNS FLOAT AS $$
DECLARE
  days_since FLOAT;
  access_bonus FLOAT;
BEGIN
  days_since := EXTRACT(EPOCH FROM (NOW() - COALESCE(p_accessed_at, NOW()))) / 86400.0;
  access_bonus := LEAST(COALESCE(p_access_count, 0) * 0.1, 1.0);
  RETURN COALESCE(p_relevance_score, 1.0) * EXP(-COALESCE(p_decay_rate, 0.01) * days_since) + access_bonus;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER) TO total_recall_app;
