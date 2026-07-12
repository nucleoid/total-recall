-- Permit the runtime role to maintain document counters without widening namespace access.
-- Migration 013 installed the canonical USING expression but relied on PostgreSQL's
-- implicit WITH CHECK fallback; make both old-row and new-row checks explicit here.
DO $$
DECLARE
  policy_record record;
  update_policy_count integer := 0;
  normalized_using text;
  normalized_check text;
  canonical_expression constant text := '(namespace=ANY(app_allowed_namespaces()))';
BEGIN
  FOR policy_record IN
    SELECT p.polname,
           p.polpermissive,
           p.polroles,
           pg_get_expr(p.polqual, p.polrelid) AS using_expression,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
    FROM pg_policy p
    WHERE p.polrelid = 'public.documents'::regclass
      AND p.polcmd = 'w'
  LOOP
    update_policy_count := update_policy_count + 1;
    normalized_using := replace(
      regexp_replace(policy_record.using_expression, '[[:space:]]', '', 'g'),
      'public.app_allowed_namespaces',
      'app_allowed_namespaces'
    );
    normalized_check := replace(
      regexp_replace(policy_record.check_expression, '[[:space:]]', '', 'g'),
      'public.app_allowed_namespaces',
      'app_allowed_namespaces'
    );

    IF NOT policy_record.polpermissive
       OR policy_record.polroles <> ARRAY[0::oid]
       OR normalized_using IS DISTINCT FROM canonical_expression
       OR (normalized_check IS NOT NULL AND normalized_check IS DISTINCT FROM canonical_expression)
    THEN
      RAISE EXCEPTION
        'incompatible documents UPDATE policy "%": expected permissive PUBLIC USING and WITH CHECK namespace = ANY(app_allowed_namespaces())',
        policy_record.polname;
    END IF;

    -- A null pg_policy.polwithcheck is the known migration-013 definition. It is
    -- currently equivalent by PostgreSQL fallback semantics, but make the check
    -- explicit so future policy changes cannot accidentally widen row moves.
    IF normalized_check IS NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON public.documents WITH CHECK (namespace = ANY(public.app_allowed_namespaces()))',
        policy_record.polname
      );
    END IF;
  END LOOP;

  IF update_policy_count = 0 THEN
    CREATE POLICY namespace_update ON public.documents FOR UPDATE
      USING (namespace = ANY(public.app_allowed_namespaces()))
      WITH CHECK (namespace = ANY(public.app_allowed_namespaces()));
  END IF;
END
$$;

-- Historical counters are intentionally repaired outside the transaction-wrapped
-- migration runner by `npm run repair:document-chunk-counts`. Keeping this
-- migration policy-only avoids an unbounded table scan, row locks, and WAL burst
-- during deployment.
