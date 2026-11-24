-- Bounded, read-only contradiction shadow auditor. The specialized key cannot
-- access raw memory/vector tables; narrow SECURITY DEFINER functions select one
-- current subject and append content-free claim/outcome receipts.

CREATE TABLE public.contradiction_shadow_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES public.contradiction_shadow_receipts(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('claim', 'outcome')),
  status TEXT NOT NULL CHECK (status IN (
    'claimed', 'no_candidates', 'classified', 'stale_evidence', 'input_too_large',
    'provider_timeout', 'provider_error', 'invalid_output'
  )),
  namespace TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level = 'normal'),
  subject_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE RESTRICT,
  subject_revision INTEGER NOT NULL CHECK (subject_revision >= 0),
  subject_content_sha256 TEXT NOT NULL CHECK (subject_content_sha256 ~ '^[a-f0-9]{64}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  candidate_set_hash TEXT NOT NULL CHECK (candidate_set_hash ~ '^[a-f0-9]{64}$'),
  candidate_manifest JSONB NOT NULL CHECK (jsonb_typeof(candidate_manifest) = 'array'
    AND jsonb_array_length(candidate_manifest) <= 5),
  classification TEXT CHECK (classification IN ('duplicate', 'refinement', 'contradiction', 'no_match')),
  confidence DOUBLE PRECISION CHECK (confidence BETWEEN 0 AND 1),
  selected_candidate_id UUID,
  classification_hash TEXT CHECK (classification_hash ~ '^[a-f0-9]{64}$'),
  provider_calls INTEGER NOT NULL CHECK (provider_calls BETWEEN 0 AND 1),
  key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK ((phase = 'claim') = (claim_id IS NULL)),
  CHECK ((status = 'classified') = (classification IS NOT NULL AND confidence IS NOT NULL
    AND classification_hash IS NOT NULL)),
  CHECK (classification <> 'no_match' OR selected_candidate_id IS NULL),
  CHECK (classification IS NULL OR classification = 'no_match' OR selected_candidate_id IS NOT NULL)
);

CREATE UNIQUE INDEX contradiction_shadow_claim_identity
ON public.contradiction_shadow_receipts(subject_id, subject_revision, policy_hash, evidence_hash)
WHERE phase = 'claim';
CREATE UNIQUE INDEX contradiction_shadow_one_outcome
ON public.contradiction_shadow_receipts(claim_id) WHERE phase = 'outcome';
CREATE INDEX contradiction_shadow_recent_scope
ON public.contradiction_shadow_receipts(namespace, access_level, created_at DESC);

ALTER TABLE public.contradiction_shadow_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contradiction_shadow_receipts FROM PUBLIC, total_recall_app;

CREATE OR REPLACE FUNCTION public.app_contradiction_review_scope_allowed(
  p_namespace TEXT, p_access_level TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_access_level = 'normal'
    AND p_namespace = ANY(public.app_allowed_namespaces())
    AND EXISTS (
      SELECT 1 FROM public.api_keys key
      WHERE key.id::text = public.app_current_key_id()
        AND key.enabled AND key.revoked_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
        AND key.namespaces = ARRAY[p_namespace]::text[]
        AND key.max_access_level = p_access_level
        AND (SELECT array_agg(permission ORDER BY permission)
             FROM unnest(key.permissions) permission)
          = ARRAY['contradiction_resolve', 'read']::text[]
    )
$$;
REVOKE ALL ON FUNCTION public.app_contradiction_review_scope_allowed(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contradiction_review_scope_allowed(TEXT, TEXT) TO total_recall_app;

-- The specialized key has genuine read authority, but raw table access is still
-- denied so its database capability is exactly the two auditor functions.
DROP POLICY IF EXISTS contradiction_review_raw_deny ON public.memories;
CREATE POLICY contradiction_review_raw_deny ON public.memories AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('contradiction_resolve'))
  WITH CHECK (NOT public.app_current_key_has_permission('contradiction_resolve'));
DROP POLICY IF EXISTS contradiction_review_raw_deny ON public.documents;
CREATE POLICY contradiction_review_raw_deny ON public.documents AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('contradiction_resolve'))
  WITH CHECK (NOT public.app_current_key_has_permission('contradiction_resolve'));
DROP POLICY IF EXISTS contradiction_review_raw_deny ON public.memory_embedding_manifests;
CREATE POLICY contradiction_review_raw_deny ON public.memory_embedding_manifests AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('contradiction_resolve'))
  WITH CHECK (NOT public.app_current_key_has_permission('contradiction_resolve'));
DROP POLICY IF EXISTS contradiction_review_raw_deny ON public.memory_embedding_chunks;
CREATE POLICY contradiction_review_raw_deny ON public.memory_embedding_chunks AS RESTRICTIVE FOR ALL
  USING (NOT public.app_current_key_has_permission('contradiction_resolve'))
  WITH CHECK (NOT public.app_current_key_has_permission('contradiction_resolve'));

CREATE OR REPLACE FUNCTION public.contradiction_shadow_claim(
  p_namespace TEXT, p_access_level TEXT, p_policy_hash TEXT
) RETURNS TABLE (
  claim_id UUID, status TEXT, subject_content TEXT, candidates JSONB,
  subject_content_sha256 TEXT, evidence_hash TEXT, candidate_set_hash TEXT
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE selected RECORD;
DECLARE inserted_id UUID;
BEGIN
  IF NOT public.app_contradiction_review_scope_allowed(p_namespace, p_access_level) THEN
    RAISE EXCEPTION 'contradiction review key is not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_policy_hash IS NULL OR p_policy_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid contradiction policy hash' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO selected
  FROM (
    WITH eligible AS MATERIALIZED (
      SELECT memory.id, memory.revision, memory.content, memory.updated_at,
        encode(digest(convert_to(memory.content, 'UTF8'), 'sha256'), 'hex') AS content_sha256
      FROM public.memories memory
      JOIN public.memory_embedding_manifests manifest
        ON manifest.parent_id = memory.id
       AND manifest.contract_id = 'd38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d'
       AND manifest.is_current AND manifest.source_revision = memory.revision
       AND manifest.source_sha256 = encode(digest(convert_to(memory.content, 'UTF8'), 'sha256'), 'hex')
       AND manifest.source_bytes = octet_length(convert_to(memory.content, 'UTF8'))
       AND manifest.chunk_count BETWEEN 1 AND 64
       AND manifest.chunk_count = (SELECT count(*) FROM public.memory_embedding_chunks chunk
         WHERE chunk.contract_id = manifest.contract_id AND chunk.parent_id = manifest.parent_id)
      WHERE memory.namespace = p_namespace AND memory.access_level = p_access_level
        AND memory.memory_kind = 'semantic' AND memory.deleted_at IS NULL
        AND (memory.expires_at IS NULL OR memory.expires_at > statement_timestamp())
        AND memory.superseded_at IS NULL AND memory.valid_to IS NULL
        AND memory.valid_from <= statement_timestamp() AND memory.consolidated_into_id IS NULL
      ORDER BY memory.updated_at DESC, memory.id
      LIMIT 50
    ), pair_similarity AS (
      SELECT subject.id AS subject_id, other.id AS candidate_id,
        max(1 - (subject_chunk.embedding <=> candidate_chunk.embedding))::double precision AS similarity
      FROM eligible subject
      JOIN public.memory_embedding_chunks subject_chunk
        ON subject_chunk.parent_id = subject.id
       AND subject_chunk.contract_id = 'd38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d'
      JOIN eligible other ON other.id <> subject.id
      JOIN public.memory_embedding_chunks candidate_chunk
        ON candidate_chunk.parent_id = other.id
       AND candidate_chunk.contract_id = subject_chunk.contract_id
      GROUP BY subject.id, other.id
      HAVING max(1 - (subject_chunk.embedding <=> candidate_chunk.embedding)) >= 0.85
    ), ranked AS (
      SELECT pair.*, row_number() OVER (
        PARTITION BY pair.subject_id ORDER BY pair.similarity DESC, pair.candidate_id
      ) AS candidate_rank
      FROM pair_similarity pair
    ), assembled AS (
      SELECT subject.id, subject.revision, subject.content, subject.updated_at,
        subject.content_sha256,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', other.id, 'revision', other.revision, 'content_sha256', other.content_sha256,
          'content', other.content, 'similarity', ranked.similarity
        ) ORDER BY ranked.similarity DESC, other.id) FILTER (WHERE ranked.candidate_rank <= 5), '[]'::jsonb) AS candidates,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', other.id, 'revision', other.revision, 'content_sha256', other.content_sha256
        ) ORDER BY ranked.similarity DESC, other.id) FILTER (WHERE ranked.candidate_rank <= 5), '[]'::jsonb) AS candidate_manifest
      FROM eligible subject
      LEFT JOIN ranked ON ranked.subject_id = subject.id AND ranked.candidate_rank <= 5
      LEFT JOIN eligible other ON other.id = ranked.candidate_id
      GROUP BY subject.id, subject.revision, subject.content, subject.updated_at, subject.content_sha256
    )
    SELECT assembled.*,
      encode(digest(convert_to(assembled.candidate_manifest::text, 'UTF8'), 'sha256'), 'hex') AS candidate_set_hash,
      encode(digest(convert_to(assembled.id::text || ':' || assembled.revision::text || ':' ||
        assembled.content_sha256 || ':' || assembled.candidate_manifest::text, 'UTF8'), 'sha256'), 'hex') AS evidence_hash
    FROM assembled
    WHERE NOT EXISTS (
      SELECT 1 FROM public.contradiction_shadow_receipts receipt
      WHERE receipt.phase = 'claim' AND receipt.subject_id = assembled.id
        AND receipt.subject_revision = assembled.revision
        AND receipt.policy_hash = p_policy_hash
        AND receipt.evidence_hash = encode(digest(convert_to(assembled.id::text || ':' ||
          assembled.revision::text || ':' || assembled.content_sha256 || ':' ||
          assembled.candidate_manifest::text, 'UTF8'), 'sha256'), 'hex')
    )
    ORDER BY assembled.updated_at DESC, assembled.id
    LIMIT 1
  ) candidate;

  IF selected.id IS NULL THEN RETURN; END IF;
  INSERT INTO public.contradiction_shadow_receipts(
    phase, status, namespace, access_level, subject_id, subject_revision,
    subject_content_sha256, policy_hash, evidence_hash, candidate_set_hash,
    candidate_manifest, provider_calls, key_id
  ) VALUES (
    'claim', CASE WHEN jsonb_array_length(selected.candidates) = 0 THEN 'no_candidates' ELSE 'claimed' END,
    p_namespace, p_access_level, selected.id, selected.revision, selected.content_sha256,
    p_policy_hash, selected.evidence_hash, selected.candidate_set_hash,
    selected.candidate_manifest, 0, public.app_current_key_id()::uuid
  ) ON CONFLICT DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN RETURN; END IF;

  claim_id := inserted_id;
  status := CASE WHEN jsonb_array_length(selected.candidates) = 0 THEN 'no_candidates' ELSE 'claimed' END;
  subject_content := CASE WHEN status = 'claimed' THEN selected.content ELSE NULL END;
  candidates := CASE WHEN status = 'claimed' THEN selected.candidates ELSE '[]'::jsonb END;
  subject_content_sha256 := selected.content_sha256;
  evidence_hash := selected.evidence_hash;
  candidate_set_hash := selected.candidate_set_hash;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION public.contradiction_shadow_claim(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contradiction_shadow_claim(TEXT, TEXT, TEXT) TO total_recall_app;

CREATE OR REPLACE FUNCTION public.contradiction_shadow_append_outcome(
  p_claim_id UUID, p_status TEXT, p_classification TEXT, p_confidence DOUBLE PRECISION,
  p_selected_candidate_id UUID, p_provider_calls INTEGER
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE claim_record public.contradiction_shadow_receipts%ROWTYPE;
DECLARE manifest_item JSONB;
DECLARE current_ok BOOLEAN := true;
DECLARE final_status TEXT := p_status;
DECLARE classification_digest TEXT;
BEGIN
  SELECT * INTO claim_record FROM public.contradiction_shadow_receipts
  WHERE id = p_claim_id AND phase = 'claim' AND status = 'claimed';
  IF NOT FOUND OR NOT public.app_contradiction_review_scope_allowed(
      claim_record.namespace, claim_record.access_level) THEN
    RAISE EXCEPTION 'contradiction claim is not authorized' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contradiction_shadow_receipts WHERE claim_id = p_claim_id) THEN
    RETURN 'already_recorded';
  END IF;
  IF p_status NOT IN ('classified', 'input_too_large', 'provider_timeout', 'provider_error', 'invalid_output')
     OR p_provider_calls NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'invalid contradiction outcome' USING ERRCODE = '22023';
  END IF;

  current_ok := EXISTS (
    SELECT 1 FROM public.memories memory JOIN public.memory_embedding_manifests manifest
      ON manifest.parent_id = memory.id
     AND manifest.contract_id = 'd38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d'
     AND manifest.is_current AND manifest.source_revision = memory.revision
     AND manifest.source_sha256 = claim_record.subject_content_sha256
    WHERE memory.id = claim_record.subject_id AND memory.revision = claim_record.subject_revision
      AND memory.namespace = claim_record.namespace AND memory.access_level = claim_record.access_level
      AND memory.deleted_at IS NULL AND (memory.expires_at IS NULL OR memory.expires_at > statement_timestamp())
      AND memory.superseded_at IS NULL AND memory.valid_to IS NULL
      AND memory.valid_from <= statement_timestamp() AND memory.consolidated_into_id IS NULL
  );
  FOR manifest_item IN SELECT value FROM jsonb_array_elements(claim_record.candidate_manifest) LOOP
    current_ok := current_ok AND EXISTS (
      SELECT 1 FROM public.memories memory JOIN public.memory_embedding_manifests manifest
        ON manifest.parent_id = memory.id
       AND manifest.contract_id = 'd38fb12a30cbd3a47a4f683b714779353d9dff6c6954f3c66e910909fbd1803d'
       AND manifest.is_current AND manifest.source_revision = memory.revision
       AND manifest.source_sha256 = manifest_item->>'content_sha256'
      WHERE memory.id = (manifest_item->>'id')::uuid
        AND memory.revision = (manifest_item->>'revision')::integer
        AND memory.namespace = claim_record.namespace AND memory.access_level = claim_record.access_level
        AND memory.deleted_at IS NULL AND (memory.expires_at IS NULL OR memory.expires_at > statement_timestamp())
        AND memory.superseded_at IS NULL AND memory.valid_to IS NULL
        AND memory.valid_from <= statement_timestamp() AND memory.consolidated_into_id IS NULL
    );
  END LOOP;
  IF NOT current_ok THEN final_status := 'stale_evidence'; END IF;

  IF final_status = 'classified' THEN
    IF p_classification NOT IN ('duplicate', 'refinement', 'contradiction', 'no_match')
       OR p_confidence NOT BETWEEN 0 AND 1
       OR (p_classification = 'no_match' AND p_selected_candidate_id IS NOT NULL)
       OR (p_classification <> 'no_match' AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(claim_record.candidate_manifest) item
         WHERE item->>'id' = p_selected_candidate_id::text
       )) THEN
      RAISE EXCEPTION 'invalid contradiction classification receipt' USING ERRCODE = '22023';
    END IF;
    classification_digest := encode(digest(convert_to(jsonb_build_object(
      'classification', p_classification, 'confidence', p_confidence,
      'candidate_id', p_selected_candidate_id
    )::text, 'UTF8'), 'sha256'), 'hex');
  END IF;

  INSERT INTO public.contradiction_shadow_receipts(
    claim_id, phase, status, namespace, access_level, subject_id, subject_revision,
    subject_content_sha256, policy_hash, evidence_hash, candidate_set_hash,
    candidate_manifest, classification, confidence, selected_candidate_id,
    classification_hash, provider_calls, key_id
  ) VALUES (
    p_claim_id, 'outcome', final_status, claim_record.namespace, claim_record.access_level,
    claim_record.subject_id, claim_record.subject_revision, claim_record.subject_content_sha256,
    claim_record.policy_hash, claim_record.evidence_hash, claim_record.candidate_set_hash,
    claim_record.candidate_manifest,
    CASE WHEN final_status = 'classified' THEN p_classification ELSE NULL END,
    CASE WHEN final_status = 'classified' THEN p_confidence ELSE NULL END,
    CASE WHEN final_status = 'classified' THEN p_selected_candidate_id ELSE NULL END,
    CASE WHEN final_status = 'classified' THEN classification_digest ELSE NULL END,
    p_provider_calls, public.app_current_key_id()::uuid
  );
  RETURN final_status;
END
$$;
REVOKE ALL ON FUNCTION public.contradiction_shadow_append_outcome(UUID, TEXT, TEXT, DOUBLE PRECISION, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contradiction_shadow_append_outcome(UUID, TEXT, TEXT, DOUBLE PRECISION, UUID, INTEGER) TO total_recall_app;
