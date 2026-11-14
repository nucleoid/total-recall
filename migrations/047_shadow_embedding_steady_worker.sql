ALTER TABLE public.embedding_serving_settings
  ADD COLUMN steady_worker_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN steady_worker_last_error TEXT CHECK (steady_worker_last_error IS NULL OR steady_worker_last_error ~ '^[a-z0-9_.]{1,96}$');

CREATE FUNCTION public.require_steady_plan_for_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete'
    AND (jsonb_typeof(NEW.manifest->'steadyState') IS DISTINCT FROM 'object'
      OR NEW.manifest#>>'{steadyState,runtime,expectedRuntimeMode}' IS DISTINCT FROM 'cpu'
      OR NOT EXISTS(SELECT 1 FROM public.embedding_serving_settings s
        JOIN public.embedding_contracts c ON c.id=s.contract_id
        JOIN public.embedding_cutover_attestations a ON a.contract_id=s.contract_id AND a.run_id=s.cutover_attestation_run_id
        WHERE s.singleton AND s.contract_id=NEW.contract_id AND s.cutover_attestation_run_id=NEW.id
          AND s.capture_required AND c.capture_enabled AND s.steady_worker_enabled)) THEN
    RAISE EXCEPTION 'embedding.steady_plan_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_run_steady_completion BEFORE UPDATE OF status ON public.embedding_runs
FOR EACH ROW EXECUTE FUNCTION public.require_steady_plan_for_completion();
REVOKE ALL ON FUNCTION public.require_steady_plan_for_completion() FROM PUBLIC,total_recall_app;
