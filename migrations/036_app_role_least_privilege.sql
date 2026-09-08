-- Remove broad legacy grants from installations provisioned before role
-- separation was tightened. Re-grant only the runtime privileges declared by
-- the numbered migrations. The application must never mutate its own ledger.
REVOKE ALL PRIVILEGES ON public.schema_migrations FROM total_recall_app;

REVOKE ALL PRIVILEGES ON public.memories FROM total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.documents FROM total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.documents TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.api_keys FROM total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.sync_state FROM total_recall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_state TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.audit_log FROM total_recall_app;
GRANT SELECT, INSERT ON public.audit_log TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.agents FROM total_recall_app;
GRANT SELECT, INSERT, UPDATE ON public.agents TO total_recall_app;

REVOKE ALL PRIVILEGES ON public.recall_traces FROM total_recall_app;
GRANT SELECT, INSERT ON public.recall_traces TO total_recall_app;
