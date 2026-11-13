# Durable memory ingestion

`memory_store` (MCP) and `POST /api/store` can acknowledge a committed memory before its embedding provider recovers. Enable `MEMORY_INGESTION_QUEUE_ENABLED=true` only after applying migration 037 and starting the dedicated worker. The default is off and preserves synchronous storage. `memory_update`, document storage and session storage retain their existing paths; issues #159–#161 adopt the shared primitives separately.

Acceptance validates permission, namespace, access level and TTL, resolves the agent, then commits the real memory with a NULL embedding, a content-free job and an audit event in one transaction. Database failure is never acknowledged as acceptance. The UUID is the real memory ID. TTL starts at acceptance, not readiness.

With the gate enabled, store responses keep the existing required fields and add `state: ready | queued` and `accepted_at`. A queued response has `created: true`, `deduplicated: false`, and no similarity. Healthy inline completion returns the normal result, including the actual canonical ID and similarity on dedupe. `MEMORY_STORE_INLINE_EMBED_MS=3000` bounds inline provider work (embedding and any mutation classification) independently of `EMBEDDING_TIMEOUT_MS`; `0` makes acceptance always asynchronous. Database acceptance/finalization time is additional. If a provider ignores cancellation, its late result cannot finalize.

Jobs move from `pending` to `processing`, then `ready` or `deduplicated`. Retryable errors move to `retry_wait`; invalid input/vector or exhausted retries become `embedding_failed`. Expired/forgotten memories are cancelled. A processing lease can be reclaimed after a crash. Every completion and failure is fenced by a fresh lease token, so a stale process cannot boost, revise, audit or notify twice.

Pending and failed content remains recallable, listable, exportable and full-text searchable. It is absent from vector ranking until ready. When migration 037 is present, recall/list/search expose `ingestion`; the accepting owner sees timestamps, attempts, retry time, failure category and canonical ID, while other readers see state only. A deduplicated accepted ID resolves to the current authorized canonical row for its accepting owner. Forgetting or expiry still prevents recall. Exports add `ingestion_state`; import always generates destination embeddings and never trusts that advisory state or transfers vectors.

Idempotency keys retain the same key-scoped hash and memory UUID. Identical pending/retry/processing requests do not create another job or acceptance audit. Identical ready requests refresh metadata without re-embedding. Changed content, namespace or access invalidates the lease and clears the old vector/identity together, resetting processing/ready/failed jobs to pending. A tombstoned, superseded or inaccessible keyed row is never revived. Queued responses use created:true for acceptance; healthy keyed updates retain created:false, and keyed acceptance audit details retain idempotent:true.

Dedupe takes the existing namespace/access advisory lock, excludes the pending row and matches only current eligible rows in the same vector space. The canonical row is boosted and the pending row is soft-deleted. Contradiction classification runs before any finalization row/advisory locks. The fenced transaction revalidates its predecessor and finalizes the accepted row as successor; stale constraint failures roll back a savepoint and fall back to an unlinked ready row. Its existing policy, budget and scope gates still apply; shadow classification is scheduled after commit and excludes the finalized ID.

## Worker and retry policy

```sh
npm run ingest:worker -- --concurrency 4
npm run ingest:worker -- --once --max-jobs 100
```

The worker uses `INGESTION_WORKER_API_KEY`, a dedicated enabled admin key with the namespaces to drain. Claims use its admin scope, but content/finalization uses the accepting owner's ID and exactly one namespace. Revoking the accepting key after durable acceptance does not discard that write. Revoking the worker key stops new polls. Concurrency is 1–32, default 4; `--poll-ms` accepts 100–60000. Stopping API acceptance does not stop backlog drainage.

429 retries as `rate_limited`; 408/425/5xx, timeouts and transport failures retry as `transient`; 401/403 retry as `provider_auth` at the twelve-hour cap so credential outages do not dead-letter the backlog. 400/404/413/422 and invalid vectors fail immediately on worker attempts. `MEMORY_INGESTION_MAX_ATTEMPTS` defaults to 12; inline attempts do not consume this allowance. Retries reuse the webhook schedule of 1m/5m/30m/2h/12h with positive jitter and Retry-After up to the twelve-hour cap. Raw provider messages, content and credentials never enter job errors or metrics.

Jobs snapshot the active provider/model/dimensions at acceptance. A changed space fails as `space_mismatch`, rather than writing an incompatible vector. Requeue preserves the accepted target; restore that profile to retry, or use the reviewed re-embedding procedure to repair vectors. Re-embedding does not rewrite terminal job history.

## Operations

All control endpoints require admin permission and remain available for draining when API acceptance is off:

- `GET /api/ingestion/stats`: depth by status, oldest pending age, attempts histogram, failure categories, next retry, inline hit rate and last worker heartbeat. `memory_stats` includes this block when migration 037 is present.
- `POST /api/ingestion/pause` and `/api/ingestion/resume`: pause/resume new worker claims; in-flight jobs and inline requests finish. Changes are audited.
- `POST /api/ingestion/jobs/{memory_id}/requeue`: reset a live failed/cancelled job, record operator and timestamp, and audit. Ready, deleted, expired, missing and out-of-scope jobs return 409.

The admin dashboard Overview shows queue depth, age, heartbeat, inline hit rate, retries and pause/resume. Memories have ingestion state badges. No queue metric includes memory content. The worker only receives content under one accepted namespace's scope.

Migration 037 adds a disabled pending-to-ready subscription trigger. Enable it together with the insert trigger when subscriptions are live. The existing outbox identity makes repeated finalization harmless. Content updates do not create events; the pending-to-ready transition is the creation event. `episode_chunk`, sensitive and secret memories remain excluded.

See [the rollout and recovery runbook](rollouts/037-memory-ingestion-queue.md).

If an existing synchronous writer fills a pending row's vector, claim/finalization observes that vector and completes the job without dedupe, revision or overwriting the edited content. A different vector identity cancels the queued generation. Re-embedding skips pending/processing/retry_wait jobs at selection and write time. The ready trigger requires a nonterminal ingestion job, so filling a historical NULL vector does not create subscription events. An inline claim/finalization/failure-recording error after acceptance returns queued; the lease recovers it. Continuous workers use settled per-job results and bounded poll backoff across database failures, while --once reports an incomplete poll as an error.

Read/export status and canonical aliases follow schema presence, independently of the acceptance gate, so disabling new acceptance retains visibility while the worker drains. Inline deadline exhaustion hands immediately to the worker as pending; actual provider errors retain their backoff. Expired processing leases at the maximum worker attempt count become embedding_failed/transient. Worker leases cover the embedding timeout plus the approved mutation-classifier timeout and a 30-second margin, with a 150-second minimum.

The resolved queue plan gives semantic dedupe hits priority over a prepared contradiction; revision commits on a dedupe miss. The default-off synchronous implementation retains its earlier mutation-before-dedupe sequence. Operators using contradiction mutation should account for this queue priority when evaluating a rollout; similar opposing statements can dedupe. No mutation approval, scope or budget gate is bypassed.
