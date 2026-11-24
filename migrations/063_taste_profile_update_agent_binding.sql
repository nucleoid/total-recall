-- Forward repair for migration 058: qualify the local agent identifier so the
-- existing-profile update path cannot confuse it with memories.agent_id.
CREATE OR REPLACE FUNCTION public.taste_profile_apply_revision(
  p_source_namespace text,p_target_namespace text,p_category text,p_access_level text,p_period_end timestamptz,
  p_materialization_limit integer,p_source_fingerprint text,p_source_key text,p_content text,p_embedding vector,
  p_tags text[],p_metadata jsonb,p_embedding_provider text,p_embedding_model text,p_embedding_dimensions integer,
  p_series_value text,p_series_order text,p_force boolean DEFAULT false
) RETURNS TABLE(id uuid,outcome text,superseded_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE worker_id uuid; current_row record; prior_row record; v_agent_id uuid; current_fingerprint text;
  authoritative_metadata jsonb; now_at timestamptz:=statement_timestamp();
BEGIN
  IF NOT public.app_taste_profile_scope_allowed(p_source_namespace,p_access_level)
    OR NOT public.app_taste_profile_scope_allowed(p_target_namespace,p_access_level) THEN
    RAISE EXCEPTION 'taste profile apply scope is not authorized' USING ERRCODE='42501'; END IF;
  worker_id:=public.app_current_key_id()::uuid;
  SELECT snapshot.source_fingerprint INTO current_fingerprint FROM public.taste_profile_load_snapshot(
    p_source_namespace,p_category,p_access_level,p_period_end,p_materialization_limit) snapshot;
  IF current_fingerprint IS DISTINCT FROM p_source_fingerprint THEN RAISE EXCEPTION 'taste_source_changed'; END IF;
  authoritative_metadata:=COALESCE(p_metadata,'{}'::jsonb)||jsonb_build_object(
    'source_fingerprint',current_fingerprint,'source_namespace',p_source_namespace,
    'target_namespace',p_target_namespace,'access_level',p_access_level,'worker_key_id',worker_id,
    'source_owner_key_ids',(SELECT COALESCE(jsonb_agg(DISTINCT src.event_owner_key_id ORDER BY src.event_owner_key_id),'[]'::jsonb)
      FROM public.taste_profile_materialize_source(p_source_namespace,p_category,p_access_level,p_period_end,p_materialization_limit) src),
    'linked_memory_owner_key_ids',(SELECT COALESCE(jsonb_agg(DISTINCT src.linked_memory_owner_key_id ORDER BY src.linked_memory_owner_key_id)
      FILTER(WHERE src.linked_memory_owner_key_id IS NOT NULL),'[]'::jsonb)
      FROM public.taste_profile_materialize_source(p_source_namespace,p_category,p_access_level,p_period_end,p_materialization_limit) src));
  INSERT INTO public.agents(name,type,model,runtime,api_key_id,metadata)
    VALUES('media-taste-profile','system',p_metadata->>'generation_model','taste-profile-cli',worker_id,'{}')
    ON CONFLICT(api_key_id,name) WHERE api_key_id IS NOT NULL DO UPDATE SET model=excluded.model,runtime=excluded.runtime,last_seen_at=now_at
    RETURNING public.agents.id INTO v_agent_id;
  SELECT m.* INTO current_row FROM public.memories m WHERE m.client_id=worker_id::text AND m.namespace=p_target_namespace AND m.source_key=p_source_key FOR UPDATE;
  IF current_row.id IS NOT NULL AND (current_row.deleted_at IS NOT NULL OR
    CASE current_row.access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END < CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END)
    THEN RAISE EXCEPTION 'existing_derived_access_too_low'; END IF;
  IF current_row.id IS NOT NULL AND current_row.metadata->>'aggregate_hash'=p_metadata->>'aggregate_hash'
    AND current_row.metadata->>'source_fingerprint'=current_fingerprint AND NOT p_force THEN
    RETURN QUERY SELECT current_row.id,'unchanged'::text,NULL::uuid; RETURN;
  END IF;
  IF current_row.id IS NOT NULL THEN
    UPDATE public.memories SET content=p_content,embedding=p_embedding,tags=p_tags,metadata=authoritative_metadata,
      access_level=p_access_level,embedding_provider=p_embedding_provider,embedding_model=p_embedding_model,
      embedding_dimensions=p_embedding_dimensions,agent_id=v_agent_id,updated_at=now_at WHERE public.memories.id=current_row.id;
    INSERT INTO public.audit_log(client_id,action,namespace,memory_id,agent_id,resource_type,resource_id,details)
      VALUES(worker_id::text,'memory.taste-profile',p_target_namespace,current_row.id,v_agent_id,'memory',current_row.id,'{"updated":1}');
    RETURN QUERY SELECT current_row.id,'updated'::text,NULL::uuid; RETURN;
  END IF;
  SELECT m.* INTO prior_row FROM public.memories m WHERE m.client_id=worker_id::text AND m.namespace=p_target_namespace
    AND m.source='derived:media-taste' AND m.metadata->>'series'=p_series_value AND m.deleted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>now_at) AND m.superseded_at IS NULL AND m.valid_to IS NULL
    ORDER BY m.valid_from DESC NULLS LAST,m.created_at DESC,m.id DESC LIMIT 1 FOR UPDATE;
  IF prior_row.id IS NOT NULL AND COALESCE(prior_row.metadata->>'period','')>=p_series_order THEN
    RAISE EXCEPTION 'Taste-profile revisions must be applied oldest to newest per access lane'; END IF;
  IF prior_row.id IS NOT NULL THEN UPDATE public.memories SET superseded_at=now_at,valid_to=now_at,updated_at=now_at WHERE public.memories.id=prior_row.id; END IF;
  INSERT INTO public.memories(content,embedding,source,namespace,tags,metadata,access_level,client_id,agent_id,source_key,
    embedding_provider,embedding_model,embedding_dimensions,memory_kind,valid_from,supersedes_id,created_at,updated_at)
  VALUES(p_content,p_embedding,'derived:media-taste',p_target_namespace,p_tags,authoritative_metadata,p_access_level,worker_id::text,v_agent_id,p_source_key,
    p_embedding_provider,p_embedding_model,p_embedding_dimensions,'semantic',now_at,prior_row.id,now_at,now_at) RETURNING public.memories.id INTO id;
  INSERT INTO public.audit_log(client_id,action,namespace,memory_id,agent_id,resource_type,resource_id,details)
    VALUES(worker_id::text,'memory.taste-profile',p_target_namespace,id,v_agent_id,'memory',id,'{"created":1}');
  outcome:='created'; superseded_id:=prior_row.id; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.taste_profile_apply_revision(text,text,text,text,timestamptz,integer,text,text,text,vector,text[],jsonb,text,text,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_apply_revision(text,text,text,text,timestamptz,integer,text,text,text,vector,text[],jsonb,text,text,integer,text,text,boolean) TO total_recall_app;
