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

UPDATE public.memories
SET last_boosted_at = COALESCE(accessed_at, created_at, NOW())
WHERE last_boosted_at IS NULL;

ALTER TABLE public.memories
  ALTER COLUMN last_boosted_at SET DEFAULT NOW();

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
