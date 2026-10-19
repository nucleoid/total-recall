-- Canonical scalar coordinates are a compatibility field after target cutover.
-- Preserve every pre-mutation non-target coordinate before a writer replaces it,
-- including unlabelled historical vectors without inventing a provider identity.
-- This archive is not evidence of current rollback coverage: source hashes must
-- match, and observation-period writes still require budgeted Gemini generation.
CREATE TABLE legacy_embedding_vector_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_type text NOT NULL CHECK (parent_type IN ('memory','subscription')),
  parent_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_revision bigint,
  embedding_provider text,
  embedding_model text,
  embedding_dimensions integer,
  embedding vector(768) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE NULLS NOT DISTINCT(parent_type,parent_id,source_sha256,embedding_provider,embedding_model,embedding_dimensions)
);
REVOKE ALL ON legacy_embedding_vector_archive FROM PUBLIC,total_recall_app;

CREATE FUNCTION preserve_legacy_embedding_vector() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.embedding_provider IS DISTINCT FROM 'llama.cpp' THEN
    IF TG_TABLE_NAME='memories' THEN
      IF OLD.embedding IS NOT NULL THEN
        INSERT INTO public.legacy_embedding_vector_archive
          (parent_type,parent_id,source_sha256,source_revision,embedding_provider,embedding_model,embedding_dimensions,embedding)
        VALUES('memory',OLD.id,encode(public.digest(convert_to(OLD.content,'UTF8'),'sha256'),'hex'),OLD.revision,
          OLD.embedding_provider,OLD.embedding_model,OLD.embedding_dimensions,OLD.embedding)
        ON CONFLICT DO NOTHING;
      END IF;
    ELSIF OLD.query_embedding IS NOT NULL THEN
      INSERT INTO public.legacy_embedding_vector_archive
        (parent_type,parent_id,source_sha256,embedding_provider,embedding_model,embedding_dimensions,embedding)
      VALUES('subscription',OLD.id,encode(public.digest(convert_to(OLD.query_text,'UTF8'),'sha256'),'hex'),
        OLD.embedding_provider,OLD.embedding_model,OLD.embedding_dimensions,OLD.query_embedding)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION preserve_legacy_embedding_vector() FROM PUBLIC,total_recall_app;
CREATE TRIGGER preserve_memory_legacy_vector BEFORE UPDATE OF content,embedding,embedding_provider,embedding_model,embedding_dimensions
  ON memories FOR EACH ROW EXECUTE FUNCTION preserve_legacy_embedding_vector();
CREATE TRIGGER preserve_subscription_legacy_vector BEFORE UPDATE OF query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions
  ON memory_subscriptions FOR EACH ROW EXECUTE FUNCTION preserve_legacy_embedding_vector();
