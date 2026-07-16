# Media taste profiles

Taste profiles turn bounded `media_events` aggregates into recallable monthly memories. They do **not** parse media-rollup prose and are disabled unless an owner supplies a feature-specific approval policy.

## Data disclosed to the generation provider

For one category (`music` or `viewing`) and one completed calendar month, the job may disclose only:

- the category and `YYYY-MM` period;
- accepted event counts;
- bounded top service, artist/show/title, and genre counts;
- bounded 30-, 90-, 365-day, and all-time aggregate context;
- trends that meet the configured evidence and effect thresholds; and
- content-free quality warnings.

Raw events, event/account/source IDs, exact timestamps, connector metadata, memory content, credentials, and rollup prose are never included. Music and viewing use separate explicit predicates. Counts are distinct accepted events; duration, progress, and completion are not inferred.

The model can only choose evidence IDs and a four-value profile style. Entity names, numbers, and sentences are rendered locally from aggregate evidence. Unknown IDs, prose, extra fields, and malformed output are rejected. Validation is attempted at most twice; if both attempts fail, nothing is written.

## Required approvals

Create an owner-only JSON policy and set `TASTE_PROFILE_POLICY_FILE`. Approval for embeddings, consolidation, contradiction processing, distillation, reflection, or any other feature does not apply. The policy must separately record unexpired approval for:

1. the exact generation provider, model, endpoint, and dedicated credential variable;
2. provider privacy, retention, and training terms;
3. one low-sensitivity source namespace, one target namespace, and `normal` access only; and
4. per-run/monthly cost limits and the reviewed pricing model.

Example (replace every value after review):

```json
{
  "version": 1,
  "feature": "media-taste-profile",
  "enabled": true,
  "environment": "production",
  "generation": {
    "provider": "approved-gateway",
    "model": "approved-model",
    "endpoint": "https://gateway.example/generate",
    "credentialEnv": "TASTE_PROFILE_GENERATION_KEY",
    "timeoutMs": 30000
  },
  "terms": {
    "reference": "owner approval record",
    "privacyApproved": true,
    "retentionApproved": true,
    "trainingApproved": true
  },
  "scope": {
    "sourceNamespace": "media",
    "targetNamespace": "personal",
    "accessLevel": "normal"
  },
  "aggregation": {
    "minimumEvents": 10,
    "topLimit": 10,
    "trendMinimumAbsoluteChange": 3,
    "trendMinimumShareChange": 0.1
  },
  "budget": {
    "maxCallsPerRun": 2,
    "maxCostUsdPerRun": 1,
    "maxCostUsdPerMonth": 5,
    "estimatedRequestCostUsd": 0.001,
    "estimatedInputCostUsdPerMillionBytes": 1,
    "estimatedOutputCostUsdPerMillionBytes": 4,
    "monthlyControlReference": "monthly scheduler/cost alert"
  },
  "providerModelApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z"
  },
  "termsApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z"
  },
  "scopeApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z"
  },
  "budgetApproval": {
    "approved": true, "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z"
  }
}
```

Use a dedicated enabled API key with exactly the approved source and target namespaces, `read,write`, and `max_access_level=normal`. The only additional permission accepted is `admin` when the same owner credential must use the authenticated media-ingest endpoints. Because media events are owner-isolated, this must be the deliberately authorized key that owns the eligible events. Configure the generation credential named by the policy separately from embedding credentials.

## Running and scheduling

`MEDIA_TIME_ZONE` must be an IANA zone and defaults to UTC. Month windows are calculated in that zone, including DST boundary offsets.

```sh
# No provider or embedding call and no mutation (the default mode)
npm run taste-profile -- --category all --dry-run

# Calls the approved provider, writes nothing; --json explicitly reveals preview text
npm run taste-profile -- --category music --period 2026-06 --preview --json

# Generates, embeds, and atomically applies both profiles for the last completed month
npm run taste-profile -- --category all --apply
```

Supported categories are `music`, `viewing`, and `all`. `--force` is valid for preview/apply only and bypasses the unchanged-aggregate no-op. Apply historical months oldest-to-newest per category so the immutable supersession chain remains chronological; an out-of-order apply fails without mutation. Without `--json`, logs contain only counts, statuses, cost estimates, and quality-warning codes.

Schedule the idempotent apply command once per month with cron or systemd; there is no in-process scheduler. Keep the policy and API key out of command history. `maxCostUsdPerMonth` is an approved external ceiling, not an in-database spend ledger: enforce it through the required `monthlyControlReference` scheduler/provider billing control. The process enforces the per-run conservative reservation locally. Exactly two calls are allowed per category run so malformed structured output receives one retry and no more.

## Storage and failure behavior

Profiles use `source=derived:media-taste`, normal access, a model-attributed `media-taste-profile` system agent, and `profile`, `taste`, category, and period tags. One deterministic source key exists per category/month. An unchanged aggregate hash is a no-op. Changed evidence updates that period's row. A newly created month supersedes the prior active profile in the same transaction as insert and audit.

Generation and embedding finish before the write transaction. Provider, validation, embedding, transaction, or audit failure leaves the prior profile active. Low-evidence categories write nothing. Single-service, missing-entity, and approximate-timestamp warnings are retained in profile metadata and bounded evidence.

## Disablement and rollback

Disable the cron/systemd entry and remove `TASTE_PROFILE_POLICY_FILE` or set no feature credential. Existing profile/history rows remain ordinary lifecycle-managed memories. Use supported memory lifecycle operations for rollback; do not hand-delete generated rows automatically.
