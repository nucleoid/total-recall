-- Current serving selection and temporary rollback budget remain operator-owned.
ALTER TABLE public.embedding_contracts ADD CONSTRAINT embedding_contract_capture_enabled_unique UNIQUE(id,capture_enabled);
CREATE TABLE public.embedding_serving_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  contract_id TEXT NOT NULL,
  capture_required BOOLEAN NOT NULL DEFAULT true CHECK (capture_required),
  rollback_writes_enabled BOOLEAN NOT NULL DEFAULT false,
  rollback_inputs_per_minute INTEGER NOT NULL DEFAULT 1 CHECK (rollback_inputs_per_minute BETWEEN 1 AND 1000),
  rollback_until TIMESTAMPTZ,
  observation_ends_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY(contract_id,capture_required) REFERENCES public.embedding_contracts(id,capture_enabled),
  CHECK (NOT rollback_writes_enabled OR rollback_until IS NOT NULL)
);
-- Empty means Gemini still serves. Installing schema does not cut over.
GRANT SELECT ON public.embedding_serving_settings TO total_recall_app;
REVOKE INSERT,UPDATE,DELETE ON public.embedding_serving_settings FROM PUBLIC,total_recall_app;

CREATE TABLE public.embedding_rollback_usage (
  contract_id TEXT NOT NULL REFERENCES public.embedding_contracts(id),
  window_start TIMESTAMPTZ NOT NULL,
  inputs INTEGER NOT NULL CHECK (inputs BETWEEN 1 AND 1000),
  PRIMARY KEY(contract_id,window_start)
);
REVOKE ALL ON public.embedding_rollback_usage FROM PUBLIC,total_recall_app;

CREATE FUNCTION public.reserve_embedding_rollback_inputs(requested INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE settings public.embedding_serving_settings%ROWTYPE; accepted INTEGER;
BEGIN
  IF requested IS NULL OR requested < 1 OR requested > 1000 THEN
    RAISE EXCEPTION 'embedding.rollback_batch_limit';
  END IF;
  SELECT * INTO settings FROM public.embedding_serving_settings WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT settings.rollback_writes_enabled OR settings.rollback_until<=statement_timestamp()
    OR requested>settings.rollback_inputs_per_minute THEN RETURN false; END IF;
  INSERT INTO public.embedding_rollback_usage(contract_id,window_start,inputs)
  VALUES(settings.contract_id,date_trunc('minute',statement_timestamp()),requested)
  ON CONFLICT(contract_id,window_start) DO UPDATE SET inputs=embedding_rollback_usage.inputs+EXCLUDED.inputs
    WHERE embedding_rollback_usage.inputs+EXCLUDED.inputs<=settings.rollback_inputs_per_minute
  RETURNING inputs INTO accepted;
  RETURN accepted IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.reserve_embedding_rollback_inputs(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_embedding_rollback_inputs(INTEGER) TO total_recall_app;
