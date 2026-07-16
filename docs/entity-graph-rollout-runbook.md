# Entity graph rollout (#55)

Entity extraction is **disabled by default**. Applying migration `028_entity_graph.sql` creates empty graph tables and starts durable queueing for new or changed memories; it never calls a generation provider and does not enqueue historical rows.

## Required order

1. Apply migrations as the migration owner. The runtime role must remain `total_recall_app`.
2. Deploy the graph-aware application. `memory_graph` reports `indexing.complete: false` while eligible rows are unindexed and always reports bounded truncation flags.
3. Create a dedicated API key with exactly one approved low-sensitivity namespace, `max_access_level=normal`, and `read,write` permissions.
4. Record an owner-reviewed JSON policy for feature `memory-entity-extraction`. It must independently approve:
   - the named provider/model and gateway credential environment variable;
   - provider privacy, retention, and training terms;
   - exactly one namespace and `normal` access;
   - invocation and external monthly cost controls.
5. Set `ENTITY_EXTRACTION_POLICY_FILE`, `DEPLOYMENT_ENVIRONMENT`, and `ENTITY_ENRICH_API_KEY`, then run a bounded canary:
   `npm run entity:enrich -- --once --max-jobs 10`.
6. Review content-free outcome metrics before running the long-lived worker.

Embedding, contradiction, consolidation, or any other generative approval does not approve this feature. Missing, expired, mismatched, or partial policy data fails closed before source content or credentials are used.

## Historical backfill

Backfill is a separate action and requires an effective `backfillApproval` in the same policy.

1. Preview without mutation:
   `npm run entity:backfill -- --namespace <approved> --preview`
2. Review row, byte, token, output, call, and conservative cost estimates.
3. Add the explicit backfill approval, then enqueue a bounded resumable page:
   `npm run entity:backfill -- --namespace <approved> --execute --limit 1000`
4. Repeat until preview reports zero rows. The backfill only enqueues; the worker remains responsible for provider calls and its invocation budget.

## Operations and rollback

The worker claims queue rows in short scoped transactions, calls the provider outside database transactions, and revalidates exact source state before atomically replacing links. Crashed claims are reclaimed; failures retry with backoff and become dead-letter rows after five attempts. Logs and metrics contain no memory text, names, mentions, aliases, or provider output.

To roll back, stop advertising `memory_graph`, stop the worker, and optionally disable the enqueue trigger in a reviewed owner migration. Retain graph and queue data; do not automatically purge provenance. Existing reads remain tenant-scoped by transaction-local authorization, RLS, explicit namespace/access predicates, and composite namespace foreign keys.
