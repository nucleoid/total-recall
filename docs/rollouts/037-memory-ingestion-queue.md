# Rollout 037: durable memory ingestion

This is an operator procedure, not authorization to migrate a live database. No production migration, merge or deployment is part of implementation #157.

## Integration prerequisite

Pinned main ends at 036. This change adds `037_memory_ingestion_queue.sql`. Open PR #158 at `420a42dabcf692d02b42294b9f2f3a65c5c328f6` independently introduces migrations 037–047 and changes embedding/store/search. The migration loader rejects duplicate numeric prefixes. Combining these branches verbatim is invalid. Before integrating either branch, coordinate migration numbering/order and re-review embedding identity, keyed store, search and migration checksums on the actual combined head. Never rename an already applied migration or rewrite its checksum. No compatibility with PR #158 is asserted here; that branch has not been incorporated or tested.

## Canary

1. Keep `MEMORY_INGESTION_QUEUE_ENABLED` unset/false. Back up the database and use the existing owner-only `MIGRATION_DATABASE_URL` procedure to apply 037. It creates an empty job table, indexes, RLS, two instance settings fields and helper functions; it performs no content/vector backfill. ALTER TABLE on memories briefly requires a lock to install a disabled trigger. Use the migration runner lock timeout, a low-traffic window and retry on contention. The migration also qualifies the existing outbox matching query's ambiguous output `id`; historical migrations are unchanged.
2. Deploy the reviewed binary with acceptance still off. Create a dedicated enabled API key using `npm run create-key` and the normal key-management procedure. Give it admin and only the required namespaces. Store it as `INGESTION_WORKER_API_KEY` in the worker environment; do not reuse client credentials. Existing client keys and sessions need no rotation or reauthentication.
3. Configure the same active embedding profile in API and worker. Start `npm run ingest:worker -- --once --max-jobs 10 --concurrency 1` as a canary, then use `deploy/systemd/total-recall-ingestion.service` for continuous service. Verify `GET /api/ingestion/stats` reports a fresh heartbeat and no unexpected pause.
4. If subscriptions are live, as owner enable **both** `memories_subscription_enqueue` and `memories_subscription_ready_enqueue` on public.memories. These database-side switches are independent of API flags. Verify exactly one ID-only outbox entry for a normal canary and none for sensitive/secret or episode chunks.
5. Enable `MEMORY_INGESTION_QUEUE_ENABLED=true`, initially in the intended namespace. Default inline budget is 3000ms; use `MEMORY_STORE_INLINE_EMBED_MS=0` for always async. Confirm healthy stores return ready, outage stores return queued with stable IDs, and queued content can be recalled/listed/full-text searched/exported. Verify recovery with the worker.
6. Watch depth, oldest age, failure categories and heartbeat. Suggested initial alerts: oldest nonterminal job >15 minutes for 10 minutes, any input/space failures, or heartbeat >3 poll intervals plus 30 seconds. Tune to provider capacity; no alerting infrastructure is installed by this change. Increase concurrency only within provider quotas, up to 32.

The default worker provider timeout is 15 seconds (`EMBEDDING_TIMEOUT_MS`, max 120 seconds). A worker lease lasts 150 seconds, allowing recovery after crashes. Inline leases include a 30-second finalization margin. The inline budget bounds embedding and mutation-classifier work; acceptance and short finalization SQL time is additional. Classification holds no database row or advisory locks.

## Recovery

- Provider rate limit/outage: leave content visible, reduce concurrency, inspect only content-free stats. Retry uses jitter/Retry-After. No hot-loop retries. Inline attempts do not consume the 12 worker-attempt allowance.
- Provider authentication: repair credentials in the existing secret store, restart affected processes, allow capped retries. They do not dead-letter the entire backlog.
- Input rejected: correct the keyed content (same memory ID, new fenced job) or, after resolving the cause, admin requeue the affected ID. Requeue is audited; ready jobs cannot be requeued.
- Embedding space mismatch: never label the old vector as new. Restore the accepted active profile and requeue, or follow `npm run reembed`'s separate repair process. Re-embedding skips active jobs and repairs other vectors without creating historical subscription events; terminal ingestion history remains intact. There is no automatic backlog retargeting.
- Stuck processing: wait for lease expiry, then let the worker reclaim. Never manually clear live leases. Late finalization is fenced.
- Pause/drain: POST pause stops new worker claims while in-flight work finishes; inline stores still operate. Disable API queue acceptance if no more jobs should be accepted. POST resume before `--once` if the worker should drain due jobs. `--once` drains currently due claims; future retries require subsequent polls/runs.
- Forget/purge cancels via soft-delete checks or FK cascade; expired jobs cancel without consuming provider work when detected at claim. Expiry during embedding is checked again at finalization.

## Rollback

Disable API acceptance first. Keep the worker on the reviewed binary while draining; future retries require waiting or a later run. Stop the ingestion unit after the backlog is handled. Retain the additive schema and accepted rows. If rolling back subscription behavior, disable both subscription triggers; enablement of only the insert trigger loses pending-to-ready events. Do not drop the queue table to roll back.

Old API binaries ignore jobs and do not create NULL-vector rows. They can read pending text, but do not expose ingestion metadata or canonical aliases. Do not run old content writers against still-pending keyed jobs: the new finalizer checks content/access and the token before writing, but old binaries do not participate in queue reset semantics. Prefer drain before rolling back writers. No downtime, backfill, reindex or data deletion is required by this migration; lock acquisition must still be controlled. Provider and worker access are new operational permissions and must follow existing approval and secret handling procedures.
