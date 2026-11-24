-- Permit a dedicated reflection key to lock already-readable source evidence
-- during apply-time revalidation without granting it any mutation path.
DROP POLICY IF EXISTS reflection_evidence_row_lock ON public.memories;
CREATE POLICY reflection_evidence_row_lock ON public.memories FOR UPDATE
  USING (
    public.app_current_key_has_permission('reflection')
    AND public.app_current_key_has_permission('read')
    AND NOT public.app_current_key_has_permission('write')
    AND NOT public.app_current_key_has_permission('admin')
    AND NOT public.app_current_key_has_permission('delete')
    AND namespace <> 'insights'
    AND namespace = ANY(public.app_allowed_namespaces())
    AND EXISTS (
      SELECT 1 FROM public.api_keys key
      WHERE key.id::text = public.app_current_key_id() AND key.enabled = true
        AND CASE COALESCE(access_level, 'normal')
          WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
          <= CASE key.max_access_level
            WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    )
  )
  WITH CHECK (false);
