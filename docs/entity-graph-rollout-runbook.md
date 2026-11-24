# Entity graph rollout (#55)

Entity extraction is **disabled by default**. Migrations 028 and 057 create the graph/queue and the dedicated non-admin worker lane. They never call generation or backfill historical rows. The approved scope includes already-stored memories in any namespace and at `normal`, `sensitive`, or `secret` only when the current extraction key genuinely authorizes that exact namespace/access lane. This does not authorize new raw My Life acquisition.

## Required order

1. Deploy the matching release and apply forward migration 057 through the normal migration runner. Do not replay migration 028.
2. Provision `ENTITY_ENRICH_API_KEY` through supported key management with all intended stored namespaces, `max_access_level=secret`, permissions `read,entity_extract`, and no `write/admin/delete`.
3. Record one owner-reviewed JSON policy per exact namespace/access-level lane. Subscription policies must use:
   - `generation.provider: openclaw-adapter`
   - `generation.model: openclaw/total-recall-synthesis`
   - the private adapter endpoint and `generation.credentialEnv: GENERATION_API_KEY`
   - `budget.mode: subscription` with bounded calls/input/output and a `usageControlReference`
4. Set `ENTITY_EXTRACTION_POLICY_FILE`, `DEPLOYMENT_ENVIRONMENT`, `ENTITY_ENRICH_API_KEY`, `GENERATION_API_KEY`, and `NODE_EXTRA_CA_CERTS`.
5. Run a bounded canary against an explicitly selected synthetic source ID so existing pending rows are untouched: `npm run entity:enrich -- --once --max-jobs 1 --memory-id <uuid>`. Each invocation accepts at most 100 unique IDs.
6. Review content-free outcomes, source-level distribution, provider-call/output usage, retries, dead rows, and graph read isolation before scheduling another lane.

Legacy paid-budget policy remains strict for compatibility, but the approved production policy has no paid API fallback or fabricated USD price. Generation uses only the isolated OpenClaw synthesis agent. Embedding configuration is unchanged.

## Authority and sensitivity contract

- The current worker key is revalidated by PostgreSQL for enabled/revoked/expiry state, direct namespace membership, and access ceiling on every queue/source/link mutation.
- Historical source `client_id` remains provenance. Entity extraction does not require a still-live creator key and does not impersonate one; this preserves approved access to legacy/imported memories.
- Materialization and apply require the exact queued namespace, access level, source revision, content hash, lifecycle state, and non-episode kind. Apply row-locks source and queue state before replacing links.
- The worker cannot ordinarily insert, update, or delete source memories or documents. Its queue insertion/update and graph-link writes are tied to matching source provenance and a genuine processing job.
- Entity rows carry no independent lower classification. Raw entity and link `SELECT` policies require at least one active linked memory within the querying key's current namespace/access ceiling. Global `display_name` is stored as the safe normalized identity; source spelling, casing, mentions, and aliases remain only on access-filtered links, so a secret-first identity cannot leak its presentation metadata through a later normal link.
- `memory_graph` rechecks active memory lifecycle and caller access on seed, traversal, memory, and indexing-status queries. Lower-clearance keys cannot receive entity names, memories, or edges backed only by higher-level links.

## Historical backfill

Backfill is separate and requires an effective `backfillApproval` in the same policy.

1. Preview one exact lane without mutation:
   `npm run entity:backfill -- --namespace <approved> --access-level <normal|sensitive|secret> --preview`
2. Review rows, input bytes/tokens, provider calls, and maximum output bytes. Subscription previews report no invented USD estimate.
3. With explicit backfill approval, enqueue one bounded page:
   `npm run entity:backfill -- --namespace <approved> --access-level <level> --execute --limit 1000`
4. Run the bounded worker and repeat until that exact-lane preview reaches zero.

For rows previously marked `done` by the old normal-only worker without links, use the explicit recovery selector; ordinary backfill intentionally does not reset them:

- Preview the exact lane: `npm run entity:backfill -- --namespace <approved> --access-level <level> --requeue-completed-without-links --preview --limit 1000`
- Prefer isolated IDs for canaries: append one or more `--memory-id <uuid>` arguments (maximum 100), execute with `--limit` no larger than that list, then run the worker with the same IDs.
- Execute only an owner-reviewed bounded page: `npm run entity:backfill -- --namespace <approved> --access-level <level> --requeue-completed-without-links --execute --limit 1000`

Recovery admits only `done`, unlocked, linkless rows whose current source revision, content hash, namespace, access level, lifecycle, and kind still match the durable queue snapshot. It resets only the selected rows to pending; it cannot blanket-reset processing/retry/dead rows or rows that already have links.

Backfill only creates or explicitly reopens provenance-matching queue rows. It does not call generation, alter source content, widen namespaces, or merge access levels.

## Replay, operations, and rollback

The worker claims one exact lane in short transactions, generates outside transactions, then atomically revalidates and replaces links. Source updates increment the source revision, remove stale links, and enqueue a fresh durable job. Completed jobs are not regenerated; abandoned claims retry with backoff and become dead after five attempts. Logs contain no source text, entity names, aliases, mentions, or provider output.

Rollback by stopping entity workers/backfills and disabling `memory_graph` advertisement if required. Retain migration 057, queue rows, entities, and links for audit/replay; do not delete provenance. Parent owns migration application, key/policy/secret installation, scheduling, live canaries, and rollback execution.
