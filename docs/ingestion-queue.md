# Durable write-ahead ingestion queue for `memory_store`

Migration 037 and `MEMORY_INGESTION_QUEUE_ENABLED=true` make `memory_store` (MCP and `POST /api/store`) independent of synchronous embedding availability. A valid, authorized request is persisted first and acknowledged with a stable id; the embedding, semantic dedupe and contradiction processing happen afterwards, inline when the provider answers quickly and otherwise in a separate worker that retries with bounded backoff. Nothing accepted is ever discarded because the provider is down, rate limited or rejects a later attempt.

With the gate off (the default) the synchronous store path is byte-for-byte unchanged, including its SQL, audit rows and response shapes.

## Contract

For a valid, authenticated, authorized `memory_store` request, with the gate on:

1. Validation, namespace and access-level ACL, quota, agent resolution and idempotency-key handling run synchronously, exactly as before.
2. One RLS-scoped transaction durably writes the accepted memory (a real `memories` row with `embedding = NULL` and no embedding identity), one content-free job row in `memory_ingestion_jobs`, and the `memory.store` audit row. The transaction commits before anything is acknowledged. A PostgreSQL failure here propagates as today (REST 503, MCP error): nothing is acknowledged before it is persisted.
3. The inline fast path then tries to embed within `MEMORY_STORE_INLINE_EMBED_MS`. Success finalizes in the request and returns today's exact response plus `state: 'ready'` (with the real `deduplicated`/`similarity`). Failure or budget exhaustion returns `state: 'queued'` and the worker finishes the job.
4. The response always carries the stable memory id, `state` (`ready` or `queued`) and `accepted_at`. On `queued`: `created: true`, `deduplicated: false`, no `similarity`.
5. Once acknowledged, the write survives process restarts, worker crashes, provider outages and deployments. Retries never create duplicate memories, audit rows, subscription events or contradiction revisions.

The job row is keyed by `memory_id`, carries the immutable security/provenance snapshot taken at acceptance (`client_id`, `access_level`, `allowed_namespaces`, `agent_id`, `session_id`, `source_key`, `dedupe`, `ttl_seconds`, `contradiction_eligible`) and the embedding target (`embedding_provider`, `embedding_model`, `embedding_dimensions` from the active profile). It has no content columns: metrics, the dashboard and logs read this table only. Finalization always runs under `{ namespaces: [job.namespace], keyId: job.client_id }`, the same RLS scope the original request had, so a key revoked after acceptance does not orphan the write and the worker never holds a scope wider than one job's namespace while touching memory rows.

## States and transitions

```
                 accept (store tx)            claim (worker, attempts+1; inline: no attempt)
  [request] ───────────────────────► pending ───────────────────────────────► processing
                                       ▲  ▲                                   │  │  │  │
          requeue (admin, attempts=0)  │  │ inline failure (release, no attempt) │  │  │  │
          keyed re-store (reset)       │  └──────────────────────────────────────┘  │  │  │
                                       │                                            │  │  │
                        retry_wait ◄── retryable failure (backoff) ◄────────────────┘  │  │
                            │                                                          │  │
                            └── next_attempt_at reached ──► (claim) ──► processing     │  │
                                                                                       │  │
   ready ◄── vector landed (plain or contradiction revision) ◄─────────────────────────┘  │
   deduplicated ◄── semantic dedupe hit (pending row tombstoned, canonical boosted) ◄─────┘
   embedding_failed ◄── input_rejected | space_mismatch | max attempts | provider_auth cap exhausted
   cancelled ◄── memory expired (TTL), forgotten, or missing before finalize
```

| Status | Meaning | Public `state` |
|--------|---------|----------------|
| `pending` | Accepted and waiting for a claim; also the state after an inline failure or a requeue. | `queued` |
| `processing` | Claimed with a lease (`lease_token`, `lease_expires_at`); the embed is in flight or finalization is running. Reclaimable once the lease expires. | `queued` |
| `retry_wait` | A retryable failure scheduled `next_attempt_at` by the bounded backoff. | `queued` |
| `ready` | The vector and identity landed on the memory row (`ready_at`, `finalized_at`). | `ready` |
| `deduplicated` | The accepted content collapsed into an existing memory: `canonical_memory_id` and `similarity` are recorded, the pending row is soft-deleted (`deletion_reason = 'ingestion_deduplicated'`). | `deduplicated` |
| `embedding_failed` | Terminal until an admin requeues it; content stays intact and visible with `failure_category`. | `embedding_failed` |
| `cancelled` | The memory can no longer be finalized (expired TTL, forgotten, or gone); requeueable but usually left alone. | `cancelled` |

Every write that moves a job out of `processing` is guarded by `WHERE status = 'processing' AND lease_token = $token`, so a finalizer that wakes after its lease was reclaimed (or after the job was reset by a keyed re-store) is a no-op (`outcome: 'stale'`). Lease lengths: 10 minutes for the worker, 2 minutes for the inline fast path.

Idempotent effects at finalization:

- the memory row is updated in place (never inserted again); the embedding, `embedding_provider/model/dimensions` and `updated_at` are set in one statement;
- semantic dedupe reuses the synchronous store's advisory lock (`memory-store-dedupe:[namespace, access_level]`), candidate query (excluding the pending row itself) and boost statement, so the outcome is deterministic whenever it runs;
- a contradiction revision (when `CONTRADICTION_AUTO_MUTATION_ENABLED` policy allows mutation) updates the pending row as the successor and supersedes the predecessor in the same transaction under a savepoint; shadow classification is scheduled only after commit;
- the `memory.ingest.ready` or `memory.ingest.deduplicated` audit row is written in the finalize transaction, so a rolled-back finalize leaves no audit row and a repeated finalize is impossible because the lease guard fails.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `MEMORY_INGESTION_QUEUE_ENABLED` | unset (off) | Fail-closed gate. Only the exact string `true` enables durable acceptance, the inline fast path, the `ingestion` read-path objects and the `memory_stats.ingestion` block. Off means today's synchronous path. |
| `MEMORY_STORE_INLINE_EMBED_MS` | `3000` | Inline embedding budget in milliseconds, `0`..`120000`. `0` means always async: accept, queue, never embed in the request. Independent of `EMBEDDING_TIMEOUT_MS`; it bounds `/api/store` latency during an outage. |
| `MEMORY_INGESTION_MAX_ATTEMPTS` | `12` | Worker attempts (`1`..`1000`) before a retryable failure becomes `embedding_failed`. The inline fast path never counts as an attempt. |
| `INGESTION_WORKER_API_KEY` | required by the worker | A dedicated enabled API key with the `admin` permission, used only to open claim transactions and write the heartbeat. Its namespaces bound which jobs the worker may drain. |
| `INGESTION_WORKER_CONCURRENCY` | `4` | Default for the worker's `--concurrency` flag, `1`..`32`. |
| `EMBEDDING_TIMEOUT_MS` | `15000` | Existing per-call provider timeout; bounds each worker embed. |
| `MEMORY_DEDUPE_THRESHOLD` | `0.95` | Existing dedupe threshold, applied at finalization exactly as in the synchronous path. |

Invalid non-blank values fail closed at first use with the same style of error as the other numeric knobs.

## Inline fast path

After the acceptance transaction commits, the request claims its own job under the owner scope (`status = 'pending'` only, no attempt counted, 2-minute lease), reads the content, and calls the active embedding profile with an `AbortSignal` that combines the request signal and `AbortSignal.timeout(MEMORY_STORE_INLINE_EMBED_MS)`. The shared finalize then runs under the job scope.

- Success: `state: 'ready'`; a dedupe hit returns the canonical id with `created: false`, `deduplicated: true` and `similarity`, exactly like the synchronous path.
- Provider failure, timeout or budget exhaustion: the job is released back to `pending` with a content-free `last_error_code` (`http_429`, `provider_timeout`, `connection_error`, ...) and no attempt counted; the response is `state: 'queued'`.
- Finalize exception: the job is released with `last_error_code = 'finalize_error'`; the worker retries.
- The worker claimed it first (`not_claimed`), or the memory expired or was forgotten meanwhile: `state: 'queued'` (the worker or the cancel path resolves it).

The inline attempt is bounded by the existing per-request concurrency of the API; there is no new fan-out. Per-process counters (`attempted`, `ready`, `deduplicated`, `queued`) appear under `inline` in `GET /api/ingestion/stats`.

## Worker

`scripts/ingestion-worker.ts` is a separate process, modelled on the webhook and entity workers:

```sh
npm run ingest:worker -- --concurrency 4
# canary / drain mode
npm run ingest:worker -- --once --max-jobs 100
```

| Flag | Range | Default |
|------|-------|---------|
| `--once` | | exit when the queue is empty (or paused) instead of polling forever |
| `--max-jobs <n>` | 1..100000 | unbounded |
| `--poll-ms <ms>` | 100..60000 | 1000 |
| `--concurrency <n>` | 1..32 | `INGESTION_WORKER_CONCURRENCY` or 4 |

Key requirements: `INGESTION_WORKER_API_KEY` must name an enabled, unrevoked, unexpired API key whose permissions include `admin`. Create it with `npm run create-key -- --name ingestion-worker --namespaces <every namespace the worker may drain> --permissions admin,read,write`. The worker refuses to start on a missing, invalid, disabled or non-admin key before running any SQL. Claims run under that key's RLS scope, so only jobs in its namespaces are ever claimed; all memory and job writes run under the job's owner scope, never the worker key.

Per poll the worker writes `instance_settings.ingestion_worker_seen_at` and reads `instance_settings.ingestion_paused` in one admin-scoped transaction. While paused it sleeps (`--once` exits). Otherwise it claims one job per transaction (`FOR UPDATE SKIP LOCKED`, oldest `next_attempt_at` first, reclaiming `processing` rows whose lease expired), loads the content under the owner scope, cancels expired/forgotten/missing memories without a provider call, embeds outside any transaction or pool connection (`EMBEDDING_TIMEOUT_MS` applies), and finalizes or records the failure under the owner scope. Concurrency is a bounded in-flight set.

Signals: the first `SIGINT`/`SIGTERM` drains (no new claims; in-flight jobs finalize), a second one aborts in-flight provider calls (recorded as retryable `aborted`). The systemd unit `deploy/systemd/total-recall-ingestion.service` uses `KillSignal=SIGTERM` and `TimeoutStopSec=150` for the drain. Exit prints `[ingestion-worker] stopped { processed, ready, deduplicated, retry, failed, cancelled, stale, error }`.

The worker does not check `MEMORY_INGESTION_QUEUE_ENABLED`: it drains whenever it is started, which is what rollback relies on.

Metrics are fixed, content-free log lines: `[ingestion] outcome=<code>` from the shared primitives and `[ingestion-worker] outcome=<code>` from the worker (`ready`, `revised`, `deduplicated`, `retry_<category>`, `failed_<category>`, `failed_space_mismatch`, `cancelled_expired|deleted|missing`, `stale`, `paused`, `finalize_error`, `load_error`, `cancel_error`, `fail_error`, `job_error`). No id, namespace, content or error text is ever logged.

## Failure categories and retry

Classification is typed (`EmbeddingProviderError { status, retryAfter }` from `src/embedding.ts`), never string matching on messages:

| Cause | `failure_category` | Behaviour |
|-------|--------------------|-----------|
| HTTP 429 | `rate_limited` | retry; `Retry-After` (seconds or HTTP-date) honoured, capped at 12 h |
| 408, 425, 5xx, timeout, abort, DNS or connection failure | `transient` | retry with the bounded schedule |
| 401, 403 | `provider_auth` | retry at the 12 h cap (credential repair is operator work; the backlog is not dead-lettered) |
| 400, 404, 413, 422, or a malformed vector from the provider | `input_rejected` | `embedding_failed` immediately, content intact |
| active profile differs from the job's snapshot | `space_mismatch` | `embedding_failed`; never a cross-space vector (`npm run reembed` after a profile rotation) |
| memory expired before finalize | `expired` | `cancelled` |

The backoff is the webhook worker's curve, shared through `src/retry.ts`: 1 m, 5 m, 30 m, 2 h, 12 h with positive jitter up to 20 %, capped at 12 h. After `MEMORY_INGESTION_MAX_ATTEMPTS` worker attempts a retryable failure becomes `embedding_failed` (category of the last failure). Failed and cancelled rows keep their content, stay visible with their state, and are requeueable. There is no hot loop: a claim always schedules the next attempt in the future or moves the job to a terminal state.

## Admin endpoints

All four routes require the explicit `admin` permission, checked before any SQL. They never read or return memory content.

| Method | Path | Permissions | Behaviour |
|--------|------|-------------|-----------|
| GET | `/api/ingestion/stats` | `admin` + `read` | Depth per status, `queued` (pending + processing + retry_wait), `oldest_pending_age_seconds`, `next_retry_at`, `attempts_histogram`, `failure_categories`, this process's `inline` counters, `worker.paused`, `worker.last_seen_at`, and `enabled` (the gate). Scoped to the key's namespaces. Available with the gate off so a drain or rollback can be watched. |
| POST | `/api/ingestion/jobs/{memory_id}/requeue` | `admin` + `write` | Resets an `embedding_failed` or `cancelled` job to `pending` with `attempts = 0`, recording `requeued_by`/`requeued_at`; audited as `ingestion.requeue` on the memory. Any other state is `409 ingestion_job_state_conflict`; an absent or RLS-hidden job is `404 ingestion_job_not_found`; a malformed id is `400`. |
| POST | `/api/ingestion/pause` | `admin` + `write` | Sets `instance_settings.ingestion_paused`; the worker stops claiming at its next poll, in-flight jobs finish, durable acceptance and the inline fast path are unaffected. Audited as `ingestion.pause` (system resource). |
| POST | `/api/ingestion/resume` | `admin` + `write` | Clears the flag. Audited as `ingestion.resume`. |

`memory_stats` (MCP) and `GET /api/stats` gain the same content-free `ingestion` block (without `enabled`) as their last key, only while the gate is on.

The dashboard Overview shows an admin-only "Ingestion queue" panel (gate, queued count, oldest pending age, next retry, worker pause/heartbeat, per-status, per-category and attempts tables, inline counters) with pause/resume and requeue-by-id controls for keys holding `admin` and `write`. Memory cards show a state badge for `queued`, `deduplicated`, `embedding_failed` and `cancelled` rows (hidden for `ready`), and the inspect dialog has an Ingestion table and a "Requeue embedding" button for failed or cancelled rows.

Audit actions introduced: `memory.store` with `details.queued = true` (acceptance), `memory.ingest.ready`, `memory.ingest.deduplicated`, `ingestion.requeue`, `ingestion.pause`, `ingestion.resume`. Allowlisted detail keys gained `queued`, `requeued` and `attempts`.

## Visibility before embedding

Pending rows are visible everywhere except semantic ranking. Hiding accepted content would be the data-loss failure mode the queue removes, moved elsewhere.

| Read path | Behaviour with the gate on |
|-----------|---------------------------|
| `memory_recall` by id or `document_id`, `memory_list` | Rows carry `ingestion`: `{ state, accepted_at, ready_at, attempts, next_retry_at, failure_category, canonical_memory_id, similarity }` when the job row is visible under RLS (the owner key, or an admin key, in a namespace in scope); `{ state: 'queued' }` when the row has no visible job but its embedding is NULL; `null` otherwise. `next_retry_at` is set only in `retry_wait`. |
| Full-text search (`memory_search`, `POST /api/search`) | The text branches already match unembedded rows; every result carries the same `ingestion` object (or `null`) so a consumer can tell why a row has no vector. |
| Semantic ranking | Vector branches filter `embedding IS NOT NULL` per profile, so a pending row is never compared and never ranked across a missing or mismatched vector space. |
| `GET /api/memories`, `GET /api/memories/{id}` (dashboard) | Same `ingestion` object; the dashboard renders the badge from it. |
| Export (`GET /api/transfer/export`, `npm run memory:export`) | Pending rows are exported like any other row with a content-free `ingestion_state` (`queued`, `ready`, `deduplicated`, `embedding_failed`, `cancelled`), emitted only when non-null and excluded from the record fingerprint. Import always re-embeds with the destination profile and never reads a vector, so a queued record imports like any other. |
| Subscriptions | See [Subscription events](#subscription-events). |
| Other readers in the namespace | See `state` only (the `{ state: 'queued' }` fallback); the full object is owner/admin-only. |

With the gate off, no read path joins the job table and no `ingestion` key appears.

### Dedupe redirect

A queued memory that deduplicates at finalization is soft-deleted, but its id stays resolvable: `memory_recall` by that id returns the canonical memory with `ingestion.state = 'deduplicated'`, `canonical_memory_id` and `similarity` (owner or admin scope). The audit row records `resource_id` = the requested id and `memory_id` = the returned id. Any other soft-deleted or hidden id stays "Memory not found or access denied", including a deduplicated id requested by a non-owner.

## Idempotency key semantics across states

The keyed path keeps the same `discord-safe:v1:<sha256(keyId\0key)>` source key and the same `ON CONFLICT (client_id, source_key)` upsert ladder, now with a NULL vector and identity. Before the upsert it reads the prior row and locks its job row `FOR UPDATE` (job before memory, the same order finalize takes, so a concurrent worker cannot deadlock a retry). Keyed jobs carry `dedupe = false`, `contradiction_eligible = false` and the source key.

| Prior row | Job state | Content | Result |
|-----------|-----------|---------|--------|
| none | | | insert, enqueue, inline attempt; `created: true` |
| vector intact | `ready` (or legacy row without a job) | identical | today's metadata/tags/namespace refresh, no re-queue; `state: 'ready'` |
| vector intact | any | changed | upsert replaces content and clears the vector + identity in the same UPDATE, job reset to `pending` (attempts 0, new `accepted_at`), inline attempt |
| unembedded | `pending`, `retry_wait`, `processing` | identical | no-op: same id, `state: 'queued'`, job untouched, no inline attempt |
| unembedded | `pending`, `retry_wait`, `processing` | changed | upsert replaces content, job reset to `pending` (a worker mid-flight on the old lease becomes a no-op), inline attempt |
| unembedded | `embedding_failed`, `cancelled`, or no job | identical or changed | job (re)enqueued to `pending`, inline attempt |

Every keyed result includes `idempotency_key_honored: true`. Tombstoned and superseded source keys keep their existing typed conflicts, and a 23505 under RLS still maps to "Access denied to existing idempotent memory". `memory.store` audit details add `queued: true` only when a job was (re)enqueued.

A caller disconnect after durable acceptance is therefore safe to retry: with a key it returns the same id and the current state; without a key the retry is a second accepted memory that semantic dedupe collapses at finalization, the same outcome as a retry without a key today.

## TTL and timestamps

TTL starts at acceptance. `expires_at` is computed in the acceptance INSERT exactly as today (`statement_timestamp() + ttl`), `created_at` is the accepted time, and `ready_at`/`finalized_at` live on the job row so accepted time and ready time are recorded separately. A job whose memory has expired before claim or finalize is marked `cancelled` with `failure_category = 'expired'` and never embedded. The caller asked for N seconds of life from when they stored it; expiring stores already bypass dedupe and contradiction handling, so nothing depends on readiness time.

## Subscription events

The migration 029 insert trigger returns early on a NULL embedding, so a queued memory would never notify. Migration 037 adds `memories_ingestion_subscription_enqueue`, an `AFTER UPDATE OF embedding` trigger with `WHEN (OLD.embedding IS NULL AND NEW.embedding IS NOT NULL AND NEW.memory_kind <> 'episode_chunk')`, calling the same `enqueue_memory_subscription_webhooks()`. It ships disabled like the insert trigger; the runbook enables both together. Content updates do not create events; the pending to ready transition is the creation event for a queued memory. The outbox's `ON CONFLICT (subscription_id, memory_id, event_version) DO NOTHING` makes a replayed finalize harmless, and the lease guard prevents a second finalize in the first place. The function also skips a memory whose job has `kind = 'update'` so a later content re-embed (issue #159) is not a creation event; `store` and `document` kinds notify exactly as a synchronous insert does.

## Scope and follow-ups

This issue adopts the primitive for `memory_store` through MCP and REST only. `src/ingestion.ts` exposes `acceptMemory`, `enqueueIngestionJob`, `claimIngestionJob`, `finalizeIngestionJob`, `failIngestionJob`, `requeueIngestionJob` and the read-path helpers so that `memory_update` (#159), `memory_store_document` (#160) and `memory_store_session`/distilled facts (#161) can adopt them without a second queue; migration 037 already carries the `kind`, `source_revision`, `document_id` and `chunk_index` columns their plans describe. Until those land, `memory_update`, `memory_store_document` and `src/session-distillation.ts` embed synchronously as before.

## Tests

- `test/migration-037.test.ts`: table, FK cascade, indexes, RLS, grants, disabled trigger, function body.
- `test/ingestion.test.ts`, `test/memory-store-queue.test.ts`, `test/ingestion-worker.test.ts`, `test/ingestion-read-paths.test.ts`, `test/ingestion-admin.test.ts`: FakePool unit coverage of acceptance, inline path, claim/lease, every finalize branch, classification and backoff, keyed reuse, read paths, admin routes.
- `test/ingestion.integration.test.ts` (real PostgreSQL via Docker, skipped when unavailable): kill-at-every-boundary with injected failures, RLS visibility, worker scope confinement, exactly-once webhook outbox rows, FTS versus semantic visibility, recall/list/export shapes, TTL from acceptance, and the latency proof with a provider stub sleeping `EMBEDDING_TIMEOUT_MS`.
- `test/openapi-contract.test.ts`, `test/openapi-http.integration.test.ts`, `test/dashboard-contract.test.ts`, `test/deployment-contract.test.ts`: schemas, route parity, dashboard vocabulary, systemd unit and npm script.

Operator procedures are in [the migration 037 rollout runbook](rollouts/037-memory-ingestion-queue.md).
