-- Add the RLS-scoped database capability consumed by the future memory lifecycle.
-- This migration deliberately does not expose a public deletion tool or endpoint.
GRANT DELETE ON memories TO total_recall_app;

DROP POLICY IF EXISTS namespace_delete ON memories;
CREATE POLICY namespace_delete ON memories FOR DELETE
  USING (namespace = ANY(app_allowed_namespaces()));
