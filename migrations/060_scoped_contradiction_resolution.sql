-- Reviewed contradiction resolution lane. The dedicated key can read current
-- authorized history and invoke fixed-shape apply/reversal functions, but cannot
-- perform arbitrary source writes.

CREATE OR REPLACE FUNCTION public.app_contradiction_resolve_scope_allowed(p_namespace text, p_access_level text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.app_current_key_has_permission('contradiction_resolve')
    AND public.app_current_key_has_permission('read')
    AND NOT public.app_current_key_has_permission('write')
    AND NOT public.app_current_key_has_permission('admin')
    AND NOT public.app_current_key_has_permission('delete')
    AND p_namespace=ANY(public.app_allowed_namespaces())
    AND EXISTS(SELECT 1 FROM public.api_keys k WHERE k.id::text=public.app_current_key_id()
      AND k.enabled AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
      AND p_namespace=ANY(k.namespaces)
      AND CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
        <= CASE k.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END)
$$;
REVOKE ALL ON FUNCTION public.app_contradiction_resolve_scope_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contradiction_resolve_scope_allowed(text,text) TO total_recall_app;

CREATE TABLE public.contradiction_resolutions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL,
  access_level text NOT NULL CHECK(access_level IN('normal','sensitive','secret')),
  predecessor_id uuid NOT NULL,
  successor_id uuid NOT NULL,
  prompt_sources jsonb NOT NULL CHECK(jsonb_typeof(prompt_sources)='array' AND jsonb_array_length(prompt_sources) BETWEEN 2 AND 6),
  receipt_fingerprint text NOT NULL CHECK(receipt_fingerprint~'^[0-9a-f]{64}$'),
  decision_fingerprint text NOT NULL UNIQUE CHECK(decision_fingerprint~'^[0-9a-f]{64}$'),
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reversed_at timestamptz,
  reversal_memory_id uuid,
  status text NOT NULL DEFAULT 'applied' CHECK(status IN('applied','reversed')),
  UNIQUE(predecessor_id), UNIQUE(successor_id), CHECK(predecessor_id<>successor_id),
  FOREIGN KEY(namespace,predecessor_id) REFERENCES public.memories(namespace,id),
  FOREIGN KEY(namespace,successor_id) REFERENCES public.memories(namespace,id),
  FOREIGN KEY(namespace,reversal_memory_id) REFERENCES public.memories(namespace,id)
);
ALTER TABLE public.contradiction_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY contradiction_resolution_read ON public.contradiction_resolutions FOR SELECT USING(
  public.app_contradiction_resolve_scope_allowed(namespace,access_level));
GRANT SELECT ON public.contradiction_resolutions TO total_recall_app;

-- Exclude the dedicated resolver from all ordinary memory mutation paths.
DROP POLICY IF EXISTS namespace_insert ON public.memories;
CREATE POLICY namespace_insert ON public.memories FOR INSERT WITH CHECK(
  NOT public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('session_distill')
  AND NOT public.app_current_key_has_permission('entity_extract')
  AND NOT public.app_current_key_has_permission('contradiction_resolve')
  AND namespace=ANY(public.app_allowed_namespaces()) AND namespace<>'insights'
  AND origin_namespace IS NULL AND insight_content_hash IS NULL);
DROP POLICY IF EXISTS namespace_update ON public.memories;
CREATE POLICY namespace_update ON public.memories FOR UPDATE
  USING(NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND NOT public.app_current_key_has_permission('contradiction_resolve')
    AND namespace<>'insights' AND namespace=ANY(public.app_allowed_namespaces()))
  WITH CHECK(NOT public.app_current_key_has_permission('reflection')
    AND NOT public.app_current_key_has_permission('session_distill')
    AND NOT public.app_current_key_has_permission('entity_extract')
    AND NOT public.app_current_key_has_permission('contradiction_resolve')
    AND namespace<>'insights' AND namespace=ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS namespace_delete ON public.memories;
CREATE POLICY namespace_delete ON public.memories FOR DELETE USING(
  NOT public.app_current_key_has_permission('reflection')
  AND NOT public.app_current_key_has_permission('session_distill')
  AND NOT public.app_current_key_has_permission('entity_extract')
  AND NOT public.app_current_key_has_permission('contradiction_resolve')
  AND namespace<>'insights' AND namespace=ANY(public.app_allowed_namespaces()));
DROP POLICY IF EXISTS contradiction_resolution_source_lock ON public.memories;
CREATE POLICY contradiction_resolution_source_lock ON public.memories FOR UPDATE
  USING(public.app_contradiction_resolve_scope_allowed(namespace,access_level)) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.apply_reviewed_contradiction_resolution(
  p_namespace text,p_access_level text,p_predecessor uuid,p_successor uuid,
  p_prompt_sources jsonb,p_receipt_fingerprint text,p_decision_fingerprint text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_boundary timestamptz; v_count int;
BEGIN
  IF NOT public.app_contradiction_resolve_scope_allowed(p_namespace,p_access_level) THEN
    RAISE EXCEPTION 'contradiction resolution scope denied' USING ERRCODE='42501';
  END IF;
  IF p_predecessor=p_successor OR jsonb_typeof(p_prompt_sources)<>'array'
     OR jsonb_array_length(p_prompt_sources) NOT BETWEEN 2 AND 6 THEN
    RAISE EXCEPTION 'invalid contradiction resolution receipt' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.memories m WHERE m.id IN(p_predecessor,p_successor) ORDER BY m.id FOR UPDATE;
  SELECT count(DISTINCT m.id) INTO v_count FROM jsonb_array_elements(p_prompt_sources) s
  JOIN public.memories m ON m.id=(s->>'id')::uuid
  WHERE m.namespace=p_namespace AND m.revision=(s->>'revision')::int
    AND md5(m.content)=s->>'contentHash' AND m.access_level=s->>'accessLevel'
    AND m.memory_kind='semantic' AND m.deleted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
    AND m.superseded_at IS NULL AND m.valid_to IS NULL AND m.consolidated_into_id IS NULL
    AND m.valid_from<=statement_timestamp()
    AND CASE m.access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 END
      <= CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 END;
  IF v_count<>jsonb_array_length(p_prompt_sources) OR
     NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_prompt_sources) s WHERE (s->>'id')::uuid=p_predecessor) OR
     NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_prompt_sources) s WHERE (s->>'id')::uuid=p_successor) THEN
    RAISE EXCEPTION 'contradiction receipt source drift' USING ERRCODE='40001';
  END IF;
  SELECT s.valid_from INTO v_boundary FROM public.memories s JOIN public.memories p ON p.id=p_predecessor
  WHERE s.id=p_successor AND s.namespace=p_namespace AND p.namespace=p_namespace
    AND s.access_level=p_access_level AND s.valid_from>=p.valid_from
    AND s.supersedes_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.memories x WHERE x.supersedes_id=p.id);
  IF v_boundary IS NULL THEN RAISE EXCEPTION 'contradiction resolution is stale or would downgrade sensitivity' USING ERRCODE='40001'; END IF;
  UPDATE public.memories SET superseded_at=v_boundary,valid_to=v_boundary,updated_at=statement_timestamp()
    WHERE id=p_predecessor AND namespace=p_namespace AND superseded_at IS NULL AND valid_to IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'contradiction predecessor changed' USING ERRCODE='40001'; END IF;
  UPDATE public.memories SET supersedes_id=p_predecessor,updated_at=statement_timestamp()
    WHERE id=p_successor AND namespace=p_namespace AND supersedes_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'contradiction successor changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.contradiction_resolutions(namespace,access_level,predecessor_id,successor_id,prompt_sources,
    receipt_fingerprint,decision_fingerprint,applied_by)
  VALUES(p_namespace,p_access_level,p_predecessor,p_successor,p_prompt_sources,p_receipt_fingerprint,
    p_decision_fingerprint,public.app_current_key_id()) RETURNING id INTO v_id;
  INSERT INTO public.audit_log(client_id,action,namespace,memory_id,result_count)
    VALUES(public.app_current_key_id(),'contradiction.reviewed_apply',p_namespace,p_successor,1);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.apply_reviewed_contradiction_resolution(text,text,uuid,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_reviewed_contradiction_resolution(text,text,uuid,uuid,jsonb,text,text) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.reverse_reviewed_contradiction_resolution(p_resolution uuid,p_decision_fingerprint text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.contradiction_resolutions%ROWTYPE; v_boundary timestamptz; v_restored uuid;
BEGIN
  SELECT * INTO r FROM public.contradiction_resolutions WHERE id=p_resolution FOR UPDATE;
  IF NOT FOUND OR r.decision_fingerprint<>p_decision_fingerprint
     OR NOT public.app_contradiction_resolve_scope_allowed(r.namespace,r.access_level) THEN
    RAISE EXCEPTION 'contradiction reversal denied or stale' USING ERRCODE='42501';
  END IF;
  IF r.status='reversed' THEN RETURN r.reversal_memory_id; END IF;
  PERFORM 1 FROM public.memories WHERE id IN(r.predecessor_id,r.successor_id) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.memories WHERE supersedes_id=r.successor_id) THEN
    RAISE EXCEPTION 'contradiction successor has later history' USING ERRCODE='40001';
  END IF;
  SELECT statement_timestamp() INTO v_boundary;
  UPDATE public.memories SET superseded_at=v_boundary,valid_to=v_boundary,updated_at=v_boundary
    WHERE id=r.successor_id AND namespace=r.namespace AND superseded_at IS NULL AND valid_to IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'contradiction successor reversal drift' USING ERRCODE='40001'; END IF;
  INSERT INTO public.memories(content,source,namespace,tags,metadata,access_level,client_id,agent_id,session_id,
    memory_kind,valid_from,supersedes_id,relevance_score,relevance_base_score,decay_rate,accessed_at,access_count)
  SELECT p.content,p.source,p.namespace,p.tags,p.metadata,p.access_level,p.client_id,p.agent_id,p.session_id,
    p.memory_kind,v_boundary,r.successor_id,p.relevance_score,p.relevance_base_score,p.decay_rate,p.accessed_at,p.access_count
  FROM public.memories p WHERE p.id=r.predecessor_id AND p.namespace=r.namespace
  RETURNING id INTO v_restored;
  UPDATE public.contradiction_resolutions SET status='reversed',reversed_at=v_boundary,reversal_memory_id=v_restored WHERE id=r.id;
  INSERT INTO public.audit_log(client_id,action,namespace,memory_id,result_count)
    VALUES(public.app_current_key_id(),'contradiction.reviewed_reverse',r.namespace,v_restored,1);
  RETURN v_restored;
END $$;
REVOKE ALL ON FUNCTION public.reverse_reviewed_contradiction_resolution(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_reviewed_contradiction_resolution(uuid,text) TO total_recall_app;
