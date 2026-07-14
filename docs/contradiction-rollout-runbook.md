# Contradiction Classification Rollout Runbook

Contradiction classification and automatic belief revision are disabled by default. Do not reuse embedding credentials or approvals from another generative feature.

## Enablement gates

Before setting `CONTRADICTION_CLASSIFICATION_ENABLED=true`, record and review all of the following:

- `CONTRADICTION_PROCESSING_APPROVED=true`
- exact `CONTRADICTION_PROVIDER`, `CONTRADICTION_MODEL`, and `CONTRADICTION_GENERATION_ENDPOINT`
- `CONTRADICTION_PROVIDER_MODEL_APPROVED=true`
- privacy, retention, and training approvals
- exactly one approved namespace with `CONTRADICTION_SCOPE_APPROVED=true`; runtime egress remains restricted to `access_level=normal`
- `CONTRADICTION_COST_BUDGET_APPROVED=true` and a positive `CONTRADICTION_COST_BUDGET_USD`
- reviewed conservative upper bounds for all three estimate fields:
  - `CONTRADICTION_ESTIMATED_REQUEST_COST_USD`
  - `CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES`
  - `CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES`
- bounded `CONTRADICTION_SHADOW_MAX_IN_FLIGHT` and `CONTRADICTION_SHADOW_MAX_QUEUED`

Missing, malformed, zero-total estimate configuration disables classification. Automatic mutation remains independently disabled.

## What the budget means

The approved gateway response is exactly `{output: string}` and contains no authoritative usage or cost. Total Recall therefore does **not** know exact provider spend.

`CONTRADICTION_COST_BUDGET_USD` is a process-lifetime conservative reservation cap. Before each provider request, the process atomically reserves integer micro-USD for:

1. the configured fixed request estimate;
2. actual bounded system-and-input bytes at the configured input rate; and
3. the full allowed output bytes at the configured output rate.

A reservation is never refunded after dispatch, timeout, provider error, or ambiguous completion. The first approved provider/model/scope/budget/scheduler configuration is immutable for the process lifetime. In-process drift emits `runtime_config_changed` and performs no egress; it never creates a second budget or scheduler partition. Budget exhaustion emits only `budget_exhausted`, skips provider egress, and leaves the already committed store unlinked. No-candidate outcomes reserve nothing.

The counter is process-local and resets on restart. It is suitable for this single-process deployment, but it is not a durable billing ledger or a cross-replica/cross-restart ceiling. If either property is required, enforce it at the approved gateway and keep this local conservative cap as defense in depth.

## Shadow backpressure and shutdown

The runtime admits at most `CONTRADICTION_SHADOW_MAX_IN_FLIGHT` active shadows and retains at most `CONTRADICTION_SHADOW_MAX_QUEUED` queued shadows. Defaults are 2 and 8. When full, new shadow work is skipped with `shadow_saturated`; the store response is unchanged.

On shutdown, the runtime:

1. rejects new shadow work with `shadow_shutdown`;
2. drops queued work with `shadow_shutdown`;
3. waits for active shadow and synchronous classification work; candidate SQL has a local statement timeout and provider egress receives only the remaining part of `CONTRADICTION_TIMEOUT_MS`; and
4. closes the database pool after active work drains.

Metrics and logs contain fixed outcome codes only. They must never include prompts, candidate or memory IDs, namespaces, provider response bodies, SQL, endpoint credentials, or API keys.

## Rollout

1. Complete migration 025, supersession finalization, migration 026, validity backfill, and validity finalization.
2. Deploy with classification, mutation, and superseded-search demotion disabled.
3. Verify ordinary search capability caching and `valid_at` finalization probes in the target environment.
4. Configure every approval, conservative estimate, and backpressure setting above.
5. Enable shadow classification only.
6. Review content-free counts for `no_candidates`, provider outcomes, `budget_exhausted`, `shadow_saturated`, and `shadow_shutdown`.
7. Re-price estimates or raise the process-lifetime cap only through a reviewed configuration change and process restart. A restart resets reservations; account for that operationally.
8. Enable automatic mutation only after reviewed shadow metrics plus exact mutation/deployment environment approval.

## Rollback

1. Disable automatic mutation and drain mutation-capable requests.
2. Disable classification.
3. Reject new and drop queued shadows; wait up to the configured provider timeout for active shadows.
4. Disable superseded-row demotion if required.
5. Retain lifecycle columns, validity intervals, links, constraints, and indexes. Never reopen closed history or deploy a pre-#52 reader after links exist.
