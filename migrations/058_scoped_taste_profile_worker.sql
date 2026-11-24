-- Dedicated cross-owner media synthesis lane. The worker can read only fixed-shape,
-- policy-scoped evidence and can write only its own derived taste-profile memories.

CREATE OR REPLACE FUNCTION public.app_taste_profile_scope_allowed(p_namespace text, p_access_level text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_keys key
    WHERE key.id::text = public.app_current_key_id() AND key.enabled
      AND key.revoked_at IS NULL
      AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
      AND key.permissions @> ARRAY['read','taste_profile']::text[]
      AND key.permissions <@ ARRAY['read','taste_profile']::text[]
      AND p_namespace = ANY(public.app_allowed_namespaces()) AND p_namespace = ANY(key.namespaces)
      AND CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
        <= CASE key.max_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
  )
$$;
REVOKE ALL ON FUNCTION public.app_taste_profile_scope_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_taste_profile_scope_allowed(text,text) TO total_recall_app;

CREATE POLICY taste_profile_raw_deny ON public.media_events AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('taste_profile'))
  WITH CHECK (NOT public.app_current_key_has_permission('taste_profile'));
CREATE POLICY taste_profile_raw_deny ON public.memories AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('taste_profile'))
  WITH CHECK (NOT public.app_current_key_has_permission('taste_profile'));
CREATE POLICY taste_profile_raw_deny ON public.agents AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('taste_profile'))
  WITH CHECK (NOT public.app_current_key_has_permission('taste_profile'));
CREATE POLICY taste_profile_raw_deny ON public.audit_log AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('taste_profile'))
  WITH CHECK (NOT public.app_current_key_has_permission('taste_profile'));

CREATE OR REPLACE FUNCTION public.taste_profile_materialize_source(
  p_source_namespace text, p_category text, p_access_level text,
  p_window_end timestamptz, p_limit integer
) RETURNS TABLE (
  id uuid, service text, event_type text, title text, artist text, show text,
  genres text[], played_at text, metadata jsonb, memory_id uuid,
  memory_namespace text, memory_revision integer, access_level text,
  event_owner_key_id uuid, linked_memory_owner_key_id text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count bigint; v_invalid boolean;
BEGIN
  IF NOT public.app_taste_profile_scope_allowed(p_source_namespace,p_access_level)
     OR p_category NOT IN ('music','viewing') OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'taste profile source scope is not authorized' USING ERRCODE='42501';
  END IF;
  WITH candidates AS (
    SELECT e.*,m.id AS linked_id,m.namespace AS linked_namespace,m.revision AS linked_revision,
      m.access_level AS linked_access,m.client_id AS linked_owner,m.deleted_at,m.expires_at,
      m.superseded_at,m.valid_to,m.valid_from,m.consolidated_into_id,
      event_key.enabled AS event_key_enabled,event_key.revoked_at AS event_key_revoked,
      event_key.expires_at AS event_key_expires,event_key.permissions AS event_key_permissions,
      event_key.namespaces AS event_key_namespaces,event_key.max_access_level AS event_key_access,
      memory_key.enabled AS memory_key_enabled,memory_key.revoked_at AS memory_key_revoked,
      memory_key.expires_at AS memory_key_expires,memory_key.permissions AS memory_key_permissions,
      memory_key.namespaces AS memory_key_namespaces,memory_key.max_access_level AS memory_key_access
    FROM public.media_events e
    JOIN public.api_keys event_key ON event_key.id=e.client_id
    LEFT JOIN public.memories m ON m.id=e.memory_id
    LEFT JOIN public.api_keys memory_key ON memory_key.id::text=m.client_id
    WHERE e.namespace=p_source_namespace AND e.played_at<p_window_end
      AND COALESCE(m.access_level,'normal')=p_access_level
      AND CASE WHEN p_category='music' THEN
        (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
      ELSE
        (NOT (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
         AND (NULLIF(btrim(e.show),'') IS NOT NULL OR e.season IS NOT NULL OR e.episode IS NOT NULL
           OR lower(e.event_type) IN ('watch','watched','view','viewed','complete','completed')))
      END
  )
  SELECT count(*),coalesce(bool_or(
    NOT event_key_enabled OR event_key_revoked IS NOT NULL
    OR (event_key_expires IS NOT NULL AND event_key_expires<=statement_timestamp())
    OR NOT ('read'=ANY(event_key_permissions)) OR NOT (p_source_namespace=ANY(event_key_namespaces))
    OR CASE p_access_level WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END
       > CASE event_key_access WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    OR (c.memory_id IS NOT NULL AND (linked_id IS NULL OR deleted_at IS NOT NULL OR superseded_at IS NOT NULL
      OR valid_to IS NOT NULL OR consolidated_into_id IS NOT NULL
      OR (valid_from IS NOT NULL AND valid_from>statement_timestamp())
      OR (expires_at IS NOT NULL AND expires_at<=statement_timestamp())
      OR NOT (linked_namespace=ANY(public.app_allowed_namespaces()))
      OR memory_key_enabled IS DISTINCT FROM true OR memory_key_revoked IS NOT NULL
      OR (memory_key_expires IS NOT NULL AND memory_key_expires<=statement_timestamp())
      OR NOT ('read'=ANY(memory_key_permissions)) OR NOT (linked_namespace=ANY(memory_key_namespaces))
      OR CASE linked_access WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 99 END
         > CASE memory_key_access WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END
    ))),false) INTO v_count,v_invalid FROM candidates c;
  IF v_count>p_limit THEN RAISE EXCEPTION 'taste_source_materialization_limit'; END IF;
  IF v_invalid THEN RAISE EXCEPTION 'taste_source_expired_or_revoked'; END IF;
  RETURN QUERY
  SELECT e.id,e.service,e.event_type,e.title,e.artist,e.show,e.genres,e.played_at::text,e.metadata,
    e.memory_id,m.namespace,m.revision,COALESCE(m.access_level,'normal'),e.client_id,m.client_id
  FROM public.media_events e LEFT JOIN public.memories m ON m.id=e.memory_id
  WHERE e.namespace=p_source_namespace AND e.played_at<p_window_end
    AND COALESCE(m.access_level,'normal')=p_access_level
    AND CASE WHEN p_category='music' THEN
      (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
    ELSE
      (NOT (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
       AND (NULLIF(btrim(e.show),'') IS NOT NULL OR e.season IS NOT NULL OR e.episode IS NOT NULL
         OR lower(e.event_type) IN ('watch','watched','view','viewed','complete','completed')))
    END ORDER BY e.id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.taste_profile_materialize_source(text,text,text,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_materialize_source(text,text,text,timestamptz,integer) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.taste_profile_load_snapshot(
  p_source_namespace text,p_category text,p_access_level text,p_window_end timestamptz,p_limit integer
) RETURNS TABLE(snapshot jsonb,source_fingerprint text,event_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH materialized AS (
    SELECT * FROM public.taste_profile_materialize_source(
      p_source_namespace,p_category,p_access_level,p_window_end,p_limit)
  ), payload AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(materialized) ORDER BY materialized.id),'[]'::jsonb) value,
      count(*)::integer event_count FROM materialized
  )
  SELECT value,encode(public.digest(convert_to(value::text,'UTF8'),'sha256'),'hex'),event_count FROM payload
$$;
REVOKE ALL ON FUNCTION public.taste_profile_load_snapshot(text,text,text,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_load_snapshot(text,text,text,timestamptz,integer) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.taste_profile_existing_revision(
  p_target_namespace text,p_access_level text,p_source_key text
) RETURNS TABLE(id uuid,aggregate_hash text,source_fingerprint text,access_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT memory.id,memory.metadata->>'aggregate_hash',memory.metadata->>'source_fingerprint',memory.access_level
  FROM public.memories memory
  WHERE public.app_taste_profile_scope_allowed(p_target_namespace,p_access_level)
    AND memory.client_id=public.app_current_key_id() AND memory.namespace=p_target_namespace
    AND memory.source_key=p_source_key
$$;
REVOKE ALL ON FUNCTION public.taste_profile_existing_revision(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_existing_revision(text,text,text) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.taste_profile_aggregate_source(
  p_source_namespace text,p_category text,p_access_level text,p_period_start timestamptz,
  p_period_end timestamptz,p_previous_start timestamptz,p_days30 timestamptz,
  p_days90 timestamptz,p_days365 timestamptz,p_top_limit integer,p_materialization_limit integer
) RETURNS TABLE(window_name text,dimension text,value text,event_count bigint,rank bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH authorized AS (
    SELECT count(*) FROM public.taste_profile_materialize_source(
      p_source_namespace,p_category,p_access_level,p_period_end,p_materialization_limit)
  ), eligible AS (
    SELECT e.id,e.service,e.played_at,
      CASE WHEN p_category='music' THEN NULLIF(btrim(e.artist),'')
        ELSE COALESCE(NULLIF(btrim(e.show),''),NULLIF(btrim(e.title),'')) END entity,
      e.genres,(e.metadata?'played_precision' AND e.metadata->>'played_precision' NOT IN ('exact','instant')) approximate_time
    FROM public.media_events e LEFT JOIN public.memories m ON m.id=e.memory_id,authorized
    WHERE e.namespace=p_source_namespace AND e.played_at<p_period_end
      AND COALESCE(m.access_level,'normal')=p_access_level
      AND CASE WHEN p_category='music' THEN
        (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
      ELSE
        (NOT (NULLIF(btrim(e.artist),'') IS NOT NULL OR lower(e.service) IN ('spotify','ytmusic'))
         AND (NULLIF(btrim(e.show),'') IS NOT NULL OR e.season IS NOT NULL OR e.episode IS NOT NULL
           OR lower(e.event_type) IN ('watch','watched','view','viewed','complete','completed'))) END
  ),windows(window_name,window_start,window_end) AS (VALUES
    ('period',p_period_start,p_period_end),('previous',p_previous_start,p_period_start),
    ('days30',p_days30,p_period_end),('days90',p_days90,p_period_end),
    ('days365',p_days365,p_period_end),('allTime',NULL::timestamptz,p_period_end)
  ),scoped AS (SELECT w.window_name,e.* FROM windows w JOIN eligible e
    ON (w.window_start IS NULL OR e.played_at>=w.window_start) AND e.played_at<w.window_end),facts AS (
    SELECT window_name,'total'::text dimension,'events'::text value,count(DISTINCT id)::bigint event_count FROM scoped GROUP BY window_name
    UNION ALL SELECT window_name,'service',service,count(DISTINCT id)::bigint FROM scoped GROUP BY window_name,service
    UNION ALL SELECT window_name,'entity',entity,count(DISTINCT id)::bigint FROM scoped WHERE entity IS NOT NULL GROUP BY window_name,entity
    UNION ALL SELECT s.window_name,'genre',genre,count(DISTINCT s.id)::bigint FROM scoped s CROSS JOIN LATERAL unnest(s.genres) genre
      WHERE NULLIF(btrim(genre),'') IS NOT NULL GROUP BY s.window_name,genre
    UNION ALL SELECT window_name,'quality','missing_entity',count(DISTINCT id)::bigint FROM scoped WHERE entity IS NULL GROUP BY window_name
    UNION ALL SELECT window_name,'quality','approximate_timestamps',count(DISTINCT id)::bigint FROM scoped WHERE approximate_time GROUP BY window_name
  ),ranked AS (SELECT *,row_number() OVER(PARTITION BY window_name,dimension ORDER BY event_count DESC,value COLLATE "C") rank FROM facts)
  SELECT window_name,dimension,value,event_count,rank FROM ranked
  WHERE dimension IN ('total','quality') OR rank<=p_top_limit
  ORDER BY CASE window_name WHEN 'period' THEN 1 WHEN 'previous' THEN 2 WHEN 'days30' THEN 3 WHEN 'days90' THEN 4 WHEN 'days365' THEN 5 ELSE 6 END,dimension,rank,value COLLATE "C"
$$;
REVOKE ALL ON FUNCTION public.taste_profile_aggregate_source(text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_aggregate_source(text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.taste_profile_apply_revision(
  p_source_namespace text,p_target_namespace text,p_category text,p_access_level text,p_period_end timestamptz,
  p_materialization_limit integer,p_source_fingerprint text,p_source_key text,p_content text,p_embedding vector,
  p_tags text[],p_metadata jsonb,p_embedding_provider text,p_embedding_model text,p_embedding_dimensions integer,
  p_series_value text,p_series_order text,p_force boolean DEFAULT false
) RETURNS TABLE(id uuid,outcome text,superseded_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE worker_id uuid; current_row record; prior_row record; agent_id uuid; current_fingerprint text;
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
    RETURNING public.agents.id INTO agent_id;
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
      embedding_dimensions=p_embedding_dimensions,agent_id=agent_id,updated_at=now_at WHERE public.memories.id=current_row.id;
    INSERT INTO public.audit_log(client_id,action,namespace,memory_id,agent_id,resource_type,resource_id,details)
      VALUES(worker_id::text,'memory.taste-profile',p_target_namespace,current_row.id,agent_id,'memory',current_row.id,'{"updated":1}');
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
  VALUES(p_content,p_embedding,'derived:media-taste',p_target_namespace,p_tags,authoritative_metadata,p_access_level,worker_id::text,agent_id,p_source_key,
    p_embedding_provider,p_embedding_model,p_embedding_dimensions,'semantic',now_at,prior_row.id,now_at,now_at) RETURNING public.memories.id INTO id;
  INSERT INTO public.audit_log(client_id,action,namespace,memory_id,agent_id,resource_type,resource_id,details)
    VALUES(worker_id::text,'memory.taste-profile',p_target_namespace,id,agent_id,'memory',id,'{"created":1}');
  outcome:='created'; superseded_id:=prior_row.id; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.taste_profile_apply_revision(text,text,text,text,timestamptz,integer,text,text,text,vector,text[],jsonb,text,text,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.taste_profile_apply_revision(text,text,text,text,timestamptz,integer,text,text,text,vector,text[],jsonb,text,text,integer,text,text,boolean) TO total_recall_app;
