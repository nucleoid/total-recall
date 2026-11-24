# Session transcript distillation (#57)

`memory_store_session` stores a complete transcript as lossless `episode_chunk` document memories and atomically creates one asynchronous distillation run. `memory_session_status` returns only owned episode/run IDs, state, attempt/count fields, and a content-free error code. There is no REST surface.

A supplied `session_id` is the caller/namespace idempotency identity. An identical retry returns the original episode and run; changed transcript, provenance, namespace, or access level conflicts. Without `session_id`, every call creates a new episode. Transcript text is limited to 1 MiB UTF-8 and is never copied into document metadata, run rows, audit rows, lineage, or worker logs.

## Durable embedding ingestion (#161)

Apply migrations through 056, deploy the API and session worker together, and start the shared ingestion worker before enabling both `MEMORY_INGESTION_QUEUE_ENABLED=true` and `MEMORY_INGESTION_SESSION_ENABLED=true` (default off). The session sub-gate is independent of the document sub-gate. Migration 053 excludes episode chunks from local target subscription matching, including events captured by older builds; migration 056 adds the dedicated, non-admin distillation lane without changing storage acceptance.

With both gates enabled, one transaction persists the episode, all physical transcript chunks with NULL embedding/identity, one shared `kind=document` job per chunk, the existing distillation run, and the audit. Small episodes attempt one bounded inline batch using `MEMORY_STORE_INLINE_EMBED_MS` and `MEMORY_STORE_DOCUMENT_INLINE_MAX_CHUNKS` (default 8). Larger episodes return without provider work. The response adds `state: ready | queued | embedding_failed` independently of distillation `status`. Identical retries in pending, partial, ready or failed embedding states retain the episode/run IDs and add `idempotent_replay: true`; no chunks or jobs are duplicated. Existing backlog state remains visible when either acceptance gate is disabled.

Distillation reads physical transcript text and never waits for chunk vectors. Generated facts, derivations, one shared `kind=store` job per unembedded fact, and run completion commit together before any fact embedding attempt. Post-commit embedding failure leaves the run `completed` and facts queued; it cannot retry generation or spend generation budget again. An existing ready fact is reused without resetting its job. Normal, sensitive, and secret episodes are processed only by a policy for that exact access-level lane, and every derived fact inherits the maximum level of all materialized and revalidated transcript chunks.

`memory_session_status` is owner-only and content-free. With the queue schema installed it includes separate summaries, for example:

```json
{
  "status": "completed",
  "facts_stored": 1,
  "embedding": {
    "episode": { "state": "queued", "ready": 1, "queued": 2, "failed": 0 },
    "facts": { "state": "ready", "ready": 1, "queued": 0, "failed": 0 }
  }
}
```

Empty fact sets are ready. A terminal embedding failure reports `embedding_failed` when no queued work remains. Cancellation retains the existing shared document semantics: cancellation alone reports `queued`, with no new terminal session state. The shared ingestion admin requeue and worker controls handle recovery. Local target capture/publication and approved compatibility rollback use the same scalar/document primitives as other queued writes.

Rollback queued acceptance by disabling `MEMORY_INGESTION_SESSION_ENABLED`; retained jobs continue draining through the ingestion worker or `npm run reembed`. Keep the schema and completed runs. New gate-off episodes/facts use synchronous embedding. No backfill, reindex or reauthentication is required. A canary stores one approved transcript, verifies episode readiness, runs distillation, then verifies fact readiness separately. Enabling this sub-gate never enables generation.

## Fail-closed generation gate

Episode storage does **not** enable generation. The worker refuses to start unless all of the following are present and valid:

- `SESSION_DISTILLATION_POLICY_FILE`: an owner-controlled JSON approval artifact;
- `DEPLOYMENT_ENVIRONMENT`: exactly matches the artifact;
- `SESSION_DISTILLATION_API_KEY`: a dedicated enabled key containing the approved namespace, a sufficient `max_access_level`, the required worker capabilities `read` and `session_distill`, and no `write`, `admin`, or `delete` permission;
- the credential named by the policy's `generation.credentialEnv`.

Approval for embeddings, entity extraction, consolidation, contradiction handling, or any other feature does not apply. Episode chunks are excluded from entity extraction and subscription matching at the database trigger boundary. Each worker policy supports exactly one approved namespace and one exact access-level lane (`normal`, `sensitive`, or `secret`). A multi-namespace key is allowed, but it does not widen the policy lane. The accepting owner key must remain enabled and retain `read`, `write`, the source namespace, and the episode level; no worker auth context is forged.

Example policy shape (values are illustrative, not an approval):

```json
{
  "version": 1,
  "feature": "memory-session-distillation",
  "environment": "production",
  "generation": {
    "provider": "openclaw-adapter",
    "model": "openclaw/total-recall-synthesis",
    "endpoint": "https://gateway.example/generate",
    "credentialEnv": "GENERATION_API_KEY"
  },
  "terms": {
    "reference": "privacy-review/57",
    "privacyApproved": true,
    "retentionApproved": true,
    "trainingApproved": true
  },
  "scope": { "namespaces": ["approved-low-risk"], "accessLevel": "normal" },
  "budget": {
    "mode": "subscription",
    "maxInputBytesPerSession": 1100000,
    "maxOutputBytesPerSession": 65536,
    "usageControlReference": "openclaw-subscription/session-distillation"
  },
  "providerModelApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2026-12-31T00:00:00Z"
  },
  "termsApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2026-12-31T00:00:00Z"
  },
  "scopeApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2026-12-31T00:00:00Z"
  },
  "budgetApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2026-12-31T00:00:00Z"
  }
}
```

The gateway contract is the bounded contract in `src/generation.ts`, routed only through `openclaw-adapter` to the isolated `openclaw/total-recall-synthesis` agent; tools are always sent as an empty array. Subscription mode enforces input/output byte bounds and records the external usage-control reference without inventing USD prices. The strict legacy paid schema and serialized monthly reservation remain available only for backward-compatible paid policies; no paid fallback is used by the approved subscription policy.

## Operation

```bash
npm run migrate
SESSION_DISTILLATION_POLICY_FILE=/secure/session-policy.json \
DEPLOYMENT_ENVIRONMENT=production \
SESSION_DISTILLATION_API_KEY=tr_... \
GENERATION_API_KEY=... \
NODE_EXTRA_CA_CERTS=/secure/synthesis-ca.crt \
npm run session:distill -- --once --max-jobs 100
```

The worker briefly claims a run in the policy's exact namespace/access lane, reads transcript chunks only after worker and owner authorization checks, and calls generation outside transactions. Before apply it row-locks and revalidates every materialized chunk. Queued mode atomically inserts all semantic facts and lineage, uses a narrow provenance-bound database function to enqueue local embedding work, and completes the run before any embedding attempt. The dedicated worker cannot create source documents/runs or ordinarily insert, update, or delete memories. Gate-off mode embeds facts synchronously before inserting them. Output is strict JSON, capped at 50 facts, exact normalized duplicates are removed within a batch, control fields and likely credentials are rejected, and generated facts retain the episode owner and namespace at the maximum access level of all materialized/revalidated input.

Failures retain the episode. Retryable failures use bounded exponential backoff and become dead after five attempts. Source/authorization changes and immutable policy mismatches fail terminally. Subscription input/output exhaustion makes no provider call; legacy paid monthly exhaustion defers the run to the next calendar month. Runs already completed are never claimed again.

## Rollback and retention

1. Stop every `session:distill` worker.
2. Set `MEMORY_SESSION_TOOLS_ENABLED=false` and restart MCP servers to remove both session tools from advertisement and reject calls.
3. Retain episode, run, and lineage rows. Do not automatically delete them.

Ordinary authorized recall/search can see episode chunks like other document chunks. Soft-deleting chunks makes a session retry conflict and prevents future distillation. Lineage uses restrictive foreign keys, so the existing purge preview reports referenced generated facts as blocked rather than silently severing provenance. No transcript backfill, retention engine, or semantic dedupe policy is included.
