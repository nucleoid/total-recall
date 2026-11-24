-- Forward-only schema readiness for explicitly authorized all-access native synthesis.
-- This does not enable a worker or grant a key. Runtime policy and api_keys.max_access_level
-- remain independent gates, and derived records retain their effective source sensitivity.

ALTER TABLE public.memory_consolidation_runs
  DROP CONSTRAINT IF EXISTS memory_consolidation_runs_access_level_check;
ALTER TABLE public.memory_consolidation_runs
  ADD CONSTRAINT memory_consolidation_runs_access_level_check
  CHECK (access_level IN ('normal', 'sensitive', 'secret'));

ALTER TABLE public.memory_consolidation_checkpoints
  DROP CONSTRAINT IF EXISTS memory_consolidation_checkpoints_access_level_check;
ALTER TABLE public.memory_consolidation_checkpoints
  ADD CONSTRAINT memory_consolidation_checkpoints_access_level_check
  CHECK (access_level IN ('normal', 'sensitive', 'secret'));

ALTER TABLE public.memory_consolidation_memberships
  DROP CONSTRAINT IF EXISTS memory_consolidation_memberships_access_level_check;
ALTER TABLE public.memory_consolidation_memberships
  ADD CONSTRAINT memory_consolidation_memberships_access_level_check
  CHECK (access_level IN ('normal', 'sensitive', 'secret'));

DROP POLICY IF EXISTS reflection_insight_insert ON public.memories;
CREATE POLICY reflection_insight_insert ON public.memories FOR INSERT WITH CHECK (
  public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('write')
  AND namespace = 'insights' AND namespace = ANY(public.app_allowed_namespaces())
  AND origin_namespace = ANY(public.app_allowed_namespaces())
  AND memory_kind = 'insight' AND source = 'memory-reflection'
  AND access_level IN ('normal', 'sensitive', 'secret')
  AND EXISTS (
    SELECT 1 FROM public.api_keys key
    WHERE key.id::text = public.app_current_key_id() AND key.enabled = true
      AND CASE access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
        <= CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
  )
  AND client_id = public.app_current_key_id()
);
