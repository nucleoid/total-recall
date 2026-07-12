-- Stable inputs for relevance. Historical rows intentionally remain NULL until
-- scripts/repair-relevance-scores.ts applies an explicitly approved manifest.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS relevance_base_score DOUBLE PRECISION;

-- This default affects new writes only; it does not classify historical rows.
ALTER TABLE public.memories
  ALTER COLUMN relevance_base_score SET DEFAULT 1.0;

ALTER TABLE public.memories
  DROP CONSTRAINT IF EXISTS memories_relevance_base_score_valid;
ALTER TABLE public.memories
  ADD CONSTRAINT memories_relevance_base_score_valid CHECK (
    relevance_base_score IS NULL OR (
      relevance_base_score >= 0.0
      AND relevance_base_score <> 'Infinity'::DOUBLE PRECISION
      AND relevance_base_score <> '-Infinity'::DOUBLE PRECISION
      AND relevance_base_score <> 'NaN'::DOUBLE PRECISION
    )
  ) NOT VALID;

-- PostgreSQL does not allow CREATE OR REPLACE to rename input parameters.
DROP FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER);

CREATE FUNCTION public.calculate_relevance(
  p_relevance_base_score DOUBLE PRECISION,
  p_decay_rate DOUBLE PRECISION,
  p_accessed_at TIMESTAMPTZ,
  p_access_count INTEGER
) RETURNS DOUBLE PRECISION AS $$
DECLARE
  days_since DOUBLE PRECISION;
  access_bonus DOUBLE PRECISION;
BEGIN
  days_since := GREATEST(0.0, EXTRACT(EPOCH FROM (NOW() - COALESCE(p_accessed_at, NOW()))) / 86400.0);
  access_bonus := LEAST(GREATEST(COALESCE(p_access_count, 0) * 0.1, 0.0), 1.0);
  RETURN COALESCE(p_relevance_base_score, 1.0)
    * EXP(-COALESCE(p_decay_rate, 0.01) * days_since)
    + access_bonus;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER)
  TO total_recall_app;
