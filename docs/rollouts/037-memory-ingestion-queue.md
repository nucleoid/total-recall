# Migration 037 durable ingestion queue rollout

Migration 037 adds the content-free `memory_ingestion_jobs` table, the `instance_settings.ingestion_paused` and `ingestion_worker_seen_at` columns, and a disabled `AFTER UPDATE OF embedding` subscription trigger. It is additive: no backfill, no reindex, no downtime, and old binaries ignore the table because they never write a NULL embedding. The runtime behaviour changes only when `MEMORY_INGESTION_QUEUE_ENABLED=true` is set on the API processes; until then `memory_store` is byte-for-byte the synchronous path. The contract, states and read-path behaviour are in [`docs/ingestion-queue.md`](../ingestion-queue.md).

## Before migration

1. Take and verify a restorable database backup, as for every migration.
2. Confirm the embedding profile (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) is the one you intend to keep for the life of the backlog. Jobs snapshot the active profile at acceptance and fail with `space_mismatch` if it changes; plan a profile rotation only with an empty queue, followed by `npm run reembed`.
3. Decide the worker's namespace grant. The worker claims only jobs in its key's namespaces, so the key must cover every namespace that `memory_store` callers may write to while the gate is on; jobs in other namespaces stay `queued` until a worker that covers them runs.
4. If memory subscriptions are live (`MEMORY_SUBSCRIPTION_CREATION_ENABLED=true` and `memories_subscription_enqueue` enabled), read the [subscription event semantics](../subscriptions.md): the pending to ready transition becomes the creation event, so both triggers must be enabled together in step 5 below. Without step 5, queued memories never notify.

## Deploy

1. Apply the migration with the schema owner:

   ```bash
   MIGRATION_DATABASE_URL=postgresql://<owner-role>:<owner-password>@localhost:5432/<database> npm run migrate
   ```

   The runner's authority preflight now also covers `memory_ingestion_jobs`. Nothing changes for running binaries yet.

2. Deploy the release that contains migration 037 to every API process and release `scripts/` plus `node_modules` (the worker runs through `tsx`, like the webhook worker). Leave `MEMORY_INGESTION_QUEUE_ENABLED` unset.

3. Create the dedicated worker key and place it in the shared environment file as `INGESTION_WORKER_API_KEY`:

   ```bash
   npm run create-key -- --name ingestion-worker --namespaces shared,personal,work --permissions admin,read,write
   ```

   The key needs `admin` (the worker refuses to start without it) and every namespace it may drain. Do not reuse the webhook, consolidation or session worker keys.

4. Canary the worker against the empty queue, then install the unit:

   ```bash
   npm run ingest:worker -- --once --max-jobs 100
   systemctl --user enable --now total-recall-ingestion.service
   ```

   `--once` must exit with `[ingestion-worker] stopped { processed: 0, ... }` and `GET /api/ingestion/stats` must show `worker.last_seen_at` within the last few seconds. The unit file is `deploy/systemd/total-recall-ingestion.service`; it shares `WorkingDirectory` and `EnvironmentFile` with `total-recall.service`, restarts always, and drains on `SIGTERM` with a 150 s stop timeout.

5. If subscriptions are live, enable the update trigger together with the insert trigger as the database owner, in one statement so no window exists where one fires without the other:

   ```sql
   ALTER TABLE public.memories
     ENABLE TRIGGER memories_subscription_enqueue,
     ENABLE TRIGGER memories_ingestion_subscription_enqueue;
   ```

   Skip this if subscriptions are not enabled; the queue works without it.

6. Enable the gate on one API process first:

   ```dotenv
   MEMORY_INGESTION_QUEUE_ENABLED=true
   MEMORY_STORE_INLINE_EMBED_MS=3000
   MEMORY_INGESTION_MAX_ATTEMPTS=12
   ```

   Restart it, store one memory and confirm `state: 'ready'` with the provider healthy. Then exercise the queued path without breaking the provider: set `MEMORY_STORE_INLINE_EMBED_MS=0` (always async) on that one process, store a memory, confirm `state: 'queued'`, that `memory_recall` by the returned id shows `ingestion.state: 'queued'`, and that the worker moves it to `ready` within one poll. Restore the inline budget afterwards.

7. Enable the gate on the remaining API processes and restart them.

8. Watch `GET /api/ingestion/stats` and the dashboard Overview queue panel for a day against the thresholds below.

## Operate

- `GET /api/ingestion/stats` (admin + read) is the single health surface. `queued` and `oldest_pending_age_seconds` describe backlog, `depth.embedding_failed` and `failure_categories` describe dead letters, `worker.last_seen_at` describes liveness, `inline` describes this API process's fast-path hit rate.
- `POST /api/ingestion/pause` and `/resume` (admin + write) stop and restart claiming without touching acceptance: writes still land durably and the inline fast path still runs. Use pause before a provider credential rotation or a profile rotation, and before stopping the worker for maintenance so the drain is quick.
- Every operation is audited (`ingestion.pause`, `ingestion.resume`, `ingestion.requeue`, `memory.ingest.ready`, `memory.ingest.deduplicated`, and `memory.store` with `queued: true`) and none of the stats, logs or audit rows carry memory content.

## Capacity alert thresholds

The repository ships no alerting infrastructure; poll `GET /api/ingestion/stats` from your existing monitor and alert on:

| Signal | Warning | Critical | Meaning / first action |
|--------|---------|----------|------------------------|
| `worker.last_seen_at` age | > 30 s | > 5 min | No worker is polling (default poll is 1 s, also while paused). Check `systemctl --user status total-recall-ingestion.service`. |
| `worker.paused` | `true` for > 15 min | `true` for > 1 h | Someone paused and did not resume; the backlog grows while acceptance continues. |
| `oldest_pending_age_seconds` | > 300 | > 3600 | Sustained backlog: provider outage or rate limiting (`failure_categories.transient` / `rate_limited`), or the worker's key does not cover the namespace being written. |
| `queued` | > 100 | > 1000 | Acceptance outpacing drain; raise `--concurrency` (max 32) or add a worker, within provider quota. |
| `depth.embedding_failed` | > 0 | > 10 | Dead letters: `input_rejected` needs a look at the content by its owner, `space_mismatch` means the profile changed (see backlog recovery), `provider_auth` means credentials. Requeue after fixing the cause. |
| `failure_categories.provider_auth` | > 0 | | The provider rejected credentials; jobs retry at the 12 h cap. Fix `GEMINI_API_KEY` (or the Ollama endpoint) and requeue or wait. |
| `inline.queued / inline.attempted` | > 20 % over an hour | > 80 % | The inline budget is too tight for the provider's latency or the provider is degraded; `/api/store` latency is still bounded by `MEMORY_STORE_INLINE_EMBED_MS`. |

PostgreSQL capacity is unchanged in kind: when the database cannot accept the acceptance transaction, `/api/store` returns 503 exactly as the synchronous path does and nothing is acknowledged. A full disk therefore refuses new stores instead of losing them.

## Rollback

Rollback never loses data: pending rows are plain memories with a NULL embedding.

1. Unset `MEMORY_INGESTION_QUEUE_ENABLED` (or set it to anything but `true`) on every API process and restart. New stores embed synchronously again; the `ingestion` read-path fields disappear.
2. Keep the worker running until `GET /api/ingestion/stats` (still available with the gate off) shows `queued: 0`, or drain explicitly: `npm run ingest:worker -- --once`. Then `systemctl --user disable --now total-recall-ingestion.service`.
3. If the worker cannot run, any remaining `queued` rows are exactly what `npm run reembed` targets (`embedding IS NULL`); run it with the owner connection to finish them. Their job rows are then stale `pending` rows with no effect on the synchronous path.
4. Optionally disable the update trigger: `ALTER TABLE public.memories DISABLE TRIGGER memories_ingestion_subscription_enqueue;`. Leave it enabled if you may re-enable the gate later; it fires only on a NULL to non-NULL embedding transition.
5. Do not drop the table or roll back the migration. It is inert while the gate is off, and a future re-enable needs no further schema work.

An older binary can be redeployed at any point after step 1: it never writes NULL embeddings and ignores the job table.

## Backlog recovery

- Provider outage: nothing to do. Jobs sit in `retry_wait` with the 1 m / 5 m / 30 m / 2 h / 12 h schedule and drain when the provider returns; `Retry-After` is honoured on 429. Watch `next_retry_at`.
- Worker was down for a long time: start it; the claim order is oldest `next_attempt_at` first. Temporarily raise `--concurrency` within provider quota.
- Jobs exhausted `MEMORY_INGESTION_MAX_ATTEMPTS` during a long outage: they are `embedding_failed` with the last transient category and their content intact. Requeue them (below); attempts reset to 0.
- Profile rotation with a non-empty queue: every remaining job fails with `space_mismatch`. Either revert the profile and requeue, or keep the new profile and run `npm run reembed` (which re-embeds every `embedding IS NULL` row with the active profile) and then requeue nothing: the job rows stay `embedding_failed` as a record but the memories are embedded. Prefer pausing and draining before any rotation.
- Namespace not covered by the worker key: jobs stay `pending` forever and `oldest_pending_age_seconds` climbs with `failure_categories` all zero. Create or extend the worker key's namespaces and restart the worker.
- A memory forgotten or expired while queued: the FK cascade removes the job on forget/purge; an expired TTL cancels the job with `failure_category: 'expired'` and no provider call. Neither needs operator action.

## Requeue procedures

Only `embedding_failed` and `cancelled` jobs can be requeued; anything else answers 409.

Single job, by memory id (admin + write):

```bash
curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  https://<host>/api/ingestion/jobs/<memory_id>/requeue
# {"memory_id":"...","namespace":"shared","previous_status":"embedding_failed","previous_attempts":12,"requeued_at":"...","status":"pending"}
```

The dashboard offers the same action from the Overview queue panel (requeue by id) and from the inspect dialog of a failed or cancelled memory.

Bulk, after the cause is fixed: there is deliberately no REST listing of job rows, so select the content-free ids as the schema owner and requeue each one through the API so every reset is audited:

```sql
SELECT memory_id FROM public.memory_ingestion_jobs
WHERE status = 'embedding_failed' AND failure_category = 'provider_auth';
```

```bash
while read -r id; do
  curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" "https://<host>/api/ingestion/jobs/$id/requeue"
done < failed-ids.txt
```

Do not UPDATE `memory_ingestion_jobs` by hand: the API path resets the lease and attempt fields consistently and writes the `ingestion.requeue` audit row in the same transaction. Never DELETE job rows; the runtime role has no delete grant, and the FK cascade is the only intended removal path.

## Verification checklist

- `npm run migrate` reports 037 applied; `\d memory_ingestion_jobs` shows RLS enabled and no DELETE grant for `total_recall_app`.
- `npm run ingest:worker -- --once` exits cleanly with the dedicated key and refuses a key without `admin`.
- With the gate on, a store with the provider reachable returns `state: 'ready'`; with `MEMORY_STORE_INLINE_EMBED_MS=0` it returns `state: 'queued'` and the worker lands it.
- `GET /api/ingestion/stats` returns `enabled: true`, a fresh `worker.last_seen_at`, and `queued: 0` at rest.
- If subscriptions are live, a queued memory produces exactly one `webhook_deliveries` row once it is `ready`.
