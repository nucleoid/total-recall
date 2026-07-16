# Session transcript distillation (#57)

`memory_store_session` stores a complete transcript as lossless `episode_chunk` document memories and atomically creates one asynchronous distillation run. `memory_session_status` returns only owned episode/run IDs, state, attempt/count fields, and a content-free error code. There is no REST surface.

A supplied `session_id` is the caller/namespace idempotency identity. An identical retry returns the original episode and run; changed transcript, provenance, namespace, or access level conflicts. Without `session_id`, every call creates a new episode. Transcript text is limited to 1 MiB UTF-8 and is never copied into document metadata, run rows, audit rows, lineage, or worker logs.

## Fail-closed generation gate

Episode storage does **not** enable generation. The worker refuses to start unless all of the following are present and valid:

- `SESSION_DISTILLATION_POLICY_FILE`: an owner-controlled JSON approval artifact;
- `DEPLOYMENT_ENVIRONMENT`: exactly matches the artifact;
- `SESSION_DISTILLATION_API_KEY`: a dedicated key with exactly the approved namespace, `max_access_level=normal`, and `admin`, `read`, and `write` permissions;
- the credential named by the policy's `generation.credentialEnv`.

Approval for embeddings, entity extraction, consolidation, contradiction handling, or any other feature does not apply. Episode chunks are excluded from entity extraction and subscription matching at the database trigger boundary. Initial generation supports exactly one approved namespace and `normal` access. Sensitive and secret episodes can be stored but remain pending and are never claimed by this worker.

Example policy shape (values are illustrative, not an approval):

```json
{
  "version": 1,
  "feature": "memory-session-distillation",
  "environment": "production",
  "generation": {
    "provider": "approved-transcript-gateway",
    "model": "approved-model",
    "endpoint": "https://gateway.example/generate",
    "credentialEnv": "SESSION_GENERATION_KEY"
  },
  "terms": {
    "reference": "privacy-review/57",
    "privacyApproved": true,
    "retentionApproved": true,
    "trainingApproved": true
  },
  "scope": { "namespaces": ["approved-low-risk"], "accessLevel": "normal" },
  "budget": {
    "maxInputBytesPerSession": 1100000,
    "maxOutputBytesPerSession": 65536,
    "maxCostUsdPerSession": 0.25,
    "maxCostUsdPerMonth": 25,
    "estimatedRequestCostUsd": 0.001,
    "estimatedInputCostUsdPerMillionBytes": 1,
    "estimatedOutputCostUsdPerMillionBytes": 4,
    "monthlyControlReference": "provider-budget/57"
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

The gateway contract is the provider-neutral contract in `src/generation.ts`; tools are always sent as an empty array. The artifact enforces a conservative per-session reservation and a database-serialized calendar-month reservation before each provider call.

## Operation

```bash
npm run migrate
SESSION_DISTILLATION_POLICY_FILE=/secure/session-policy.json \
DEPLOYMENT_ENVIRONMENT=production \
SESSION_DISTILLATION_API_KEY=tr_... \
SESSION_GENERATION_KEY=... \
npm run session:distill -- --once --max-jobs 100
```

The worker briefly claims a run, reads transcript chunks only after policy/scope checks, calls generation and embeddings outside transactions, then atomically inserts all semantic facts, `derived_from` lineage, and the completed run state. Output is strict JSON, capped at 50 facts, exact normalized duplicates are removed within a batch, control fields and likely credentials are rejected, and generated facts inherit the episode's owner, namespace, and exact access level.

Failures retain the episode. Retryable failures use bounded exponential backoff and become dead after five attempts. Source/authorization changes and immutable policy mismatches fail terminally. Monthly budget exhaustion makes no provider call and defers the run to the next calendar month. Runs already completed are never claimed again.

## Rollback and retention

1. Stop every `session:distill` worker.
2. Set `MEMORY_SESSION_TOOLS_ENABLED=false` and restart MCP servers to remove both session tools from advertisement and reject calls.
3. Retain episode, run, and lineage rows. Do not automatically delete them.

Ordinary authorized recall/search can see episode chunks like other document chunks. Soft-deleting chunks makes a session retry conflict and prevents future distillation. Lineage uses restrictive foreign keys, so the existing purge preview reports referenced generated facts as blocked rather than silently severing provenance. No transcript backfill, retention engine, or semantic dedupe policy is included.
