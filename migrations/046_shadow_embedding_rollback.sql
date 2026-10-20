CREATE TABLE public.embedding_rollback_mutations (
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id), parent_id UUID NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'), vector_sha256 TEXT CHECK(vector_sha256~'^[a-f0-9]{64}$'),
  verified BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(contract_id,parent_id)
);
CREATE TABLE public.embedding_serving_rollbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  cutover_attestation_run_id UUID NOT NULL REFERENCES public.embedding_cutover_attestations(run_id),
  cutover_plan_sha256 TEXT NOT NULL CHECK(cutover_plan_sha256~'^[a-f0-9]{64}$'), operational_manifest_sha256 TEXT NOT NULL CHECK(operational_manifest_sha256~'^[a-f0-9]{64}$'),
  approval_sha256 TEXT NOT NULL CHECK(approval_sha256~'^[a-f0-9]{64}$'), evidence_receipt_sha256 TEXT NOT NULL CHECK(evidence_receipt_sha256~'^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 512), mutation_count BIGINT NOT NULL CHECK(mutation_count>=0),
  mutation_digest_sha256 TEXT NOT NULL CHECK(mutation_digest_sha256~'^[a-f0-9]{64}$'), prior_settings JSONB NOT NULL,
  rolled_back_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(), UNIQUE(cutover_attestation_run_id)
);
REVOKE ALL ON public.embedding_rollback_mutations,public.embedding_serving_rollbacks FROM PUBLIC,total_recall_app;

CREATE FUNCTION public.track_embedding_rollback_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.embedding_serving_settings%ROWTYPE; changed BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' AND
     (NEW.content,NEW.embedding,NEW.embedding_provider,NEW.embedding_model,NEW.embedding_dimensions)
       IS NOT DISTINCT FROM
     (OLD.content,OLD.embedding,OLD.embedding_provider,OLD.embedding_model,OLD.embedding_dimensions) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.embedding_serving_settings WHERE singleton AND rollback_writes_enabled
    AND rollback_until>statement_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  changed:=TG_OP='INSERT' OR NEW.embedding IS DISTINCT FROM OLD.embedding;
  INSERT INTO public.embedding_rollback_mutations(contract_id,parent_id,source_sha256,vector_sha256,verified,updated_at)
  VALUES(s.contract_id,NEW.id,encode(digest(convert_to(NEW.content,'UTF8'),'sha256'),'hex'),
    CASE WHEN NEW.embedding IS NULL THEN NULL ELSE encode(digest(convert_to(NEW.embedding::text,'UTF8'),'sha256'),'hex') END,
    COALESCE(changed AND NEW.embedding IS NOT NULL AND NEW.embedding_provider='gemini'
      AND NEW.embedding_model='gemini-embedding-2-preview' AND NEW.embedding_dimensions=768,false),statement_timestamp())
  ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
    vector_sha256=EXCLUDED.vector_sha256,verified=EXCLUDED.verified,updated_at=EXCLUDED.updated_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.track_embedding_rollback_mutation() FROM PUBLIC,total_recall_app;
CREATE TRIGGER track_embedding_rollback_mutation BEFORE INSERT OR UPDATE OF content,embedding,embedding_provider,embedding_model,embedding_dimensions
ON public.memories FOR EACH ROW EXECUTE FUNCTION public.track_embedding_rollback_mutation();

CREATE FUNCTION public.guard_embedding_serving_rollback_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'embedding.rollback_receipt_immutable'; END $$;
CREATE TRIGGER embedding_serving_rollback_immutable BEFORE UPDATE OR DELETE ON public.embedding_serving_rollbacks
FOR EACH ROW EXECUTE FUNCTION public.guard_embedding_serving_rollback_immutable();
