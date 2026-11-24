# Media taste profiles

Taste profiles turn bounded `media_events` aggregates into monthly memories. Activation is subscription-only and fail-closed: generation is accepted only through the private OpenClaw adapter with provider `openclaw-adapter`, model `openclaw/total-recall-synthesis`, and budget mode `subscription`. There is no USD estimate or paid-provider fallback. Embeddings continue to use the active Qwen embedding contract.

## Evidence and sensitivity lanes

Only semantically relevant media evidence is materialized. Broad authorization for `financial`, secret My Life material, or other namespaces does **not** make those records taste evidence. Eligible music and viewing events are separated by explicit predicates.

Each run uses one exact `normal`, `sensitive`, or `secret` lane. An unlinked media event is normal. A linked event inherits the linked memory's access level. Aggregation, preview, source fingerprint, and stored output stay in that exact lane. The output access level is therefore the maximum classification of every materialized input, including evidence not selected by the model. Lanes have independent source keys and supersession chains.

The provider receives only bounded aggregate facts: category, month, accepted counts, bounded services/artists/shows/titles/genres, time-window context, qualified trends, and content-free quality warnings. It never receives raw events, IDs, timestamps, credentials, source keys, ownership IDs, memory text, or control metadata. It can return only a four-value style and supplied evidence IDs; profile prose is rendered locally.

Local provenance records the source owner, source/target namespace, lane, materialized event count, aggregate hash, source fingerprint, policy hash, selection time/approval, adapter model, and active embedding descriptor. Before apply, the implementation re-reads every materialized source, the key, policy, and aggregate. Changed, missing, deleted, expired, superseded, out-of-scope, or revoked inputs fail without mutation.

## Policy and key requirements

Policy version 2 requires:

- exact adapter provider/model above and the private adapter endpoint/credential variable;
- separately unexpired provider/model, terms, scope, and subscription-usage approvals;
- the complete authorized namespace list, source/target namespace, and enabled lanes;
- exactly two bounded preview attempts, 8192 total output bytes, an external subscription-usage control reference;
- preview TTL (1–1440 minutes) and a local materialization cap.

The runtime key must be genuine, enabled, unexpired, unrevoked, and have:

- namespaces **exactly equal** to policy `scope.namespaces` (for the owner deployment this is the complete stored namespace set, including `financial` and My Life);
- `max_access_level` exactly equal to the highest enabled lane (`secret` when all lanes are enabled);
- permissions exactly `read,write`, with no `admin`, synthesis-worker, ingestion, delete, or scheduler permissions; and
- ownership of the eligible `media_events`, because media-event RLS is owner-key isolated.

That final point is an operational prerequisite, not something the job forges or bypasses. If the current event owner key has broader permissions, do not weaken isolation in deployment: reconcile ownership/key design explicitly before activation. No migration is required by this implementation.

Minimal policy shape (approval objects omitted here but required):

```json
{
  "version": 2,
  "feature": "media-taste-profile",
  "enabled": true,
  "environment": "production",
  "generation": {
    "provider": "openclaw-adapter",
    "model": "openclaw/total-recall-synthesis",
    "endpoint": "https://private-adapter.example/generate",
    "credentialEnv": "TASTE_PROFILE_OPENCLAW_ADAPTER_KEY",
    "timeoutMs": 30000
  },
  "terms": {
    "reference": "owner approval record",
    "privacyApproved": true,
    "retentionApproved": true,
    "trainingApproved": true
  },
  "scope": {
    "namespaces": ["activity", "financial", "insights", "media", "my-life", "personal", "projects", "shared", "work"],
    "sourceNamespace": "media",
    "targetNamespace": "personal",
    "accessLevels": ["normal", "sensitive", "secret"]
  },
  "aggregation": {
    "minimumEvents": 10,
    "topLimit": 10,
    "trendMinimumAbsoluteChange": 3,
    "trendMinimumShareChange": 0.1
  },
  "budget": {
    "mode": "subscription",
    "maxCallsPerRun": 2,
    "maxOutputBytesPerRun": 8192,
    "usageControlReference": "private OpenClaw subscription quota/control"
  },
  "selection": { "previewTtlMinutes": 60, "maxMaterializedEvents": 10000 },
  "providerModelApproval": { "approved": true, "approvedBy": "owner", "approvedAt": "...", "expiresAt": "..." },
  "termsApproval": { "approved": true, "approvedBy": "owner", "approvedAt": "...", "expiresAt": "..." },
  "scopeApproval": { "approved": true, "approvedBy": "owner", "approvedAt": "...", "expiresAt": "..." },
  "budgetApproval": { "approved": true, "approvedBy": "owner", "approvedAt": "...", "expiresAt": "..." }
}
```

## Preview and apply

Dry-run performs bounded local selection only and never calls generation or embedding:

```sh
npm run taste-profile -- --category all --access-level all --dry-run
```

Preview calls the adapter and emits unsigned selection receipts with `--json`; it never embeds or writes:

```sh
npm run taste-profile -- --category all --access-level all --period 2026-10 --preview --json > preview.json
```

Review each rendered profile. Copy the top-level `selections` array to a protected selection file and add an `approval` object (`approved: true`, owner identity, approval time, expiry) to each accepted receipt. Apply requires that file and makes **no generation call**:

```sh
npm run taste-profile -- --category all --access-level all --period 2026-10 --apply --selection-file approved-selections.json
```

Apply rejects a changed aggregate/fingerprint, expired policy/preview/approval, wrong category/month/lane/policy, malformed output, disabled/revoked key, or changed scope. An unchanged replay returns `unchanged` before provider or embedding use. Apply months oldest-to-newest within each category/lane.

## Rollback

Disable/remove the external schedule, remove `TASTE_PROFILE_POLICY_FILE` and the adapter credential, and disable/revoke the taste key. Existing profile memories remain lifecycle-managed records. Use supported memory lifecycle operations to retire a bad profile; do not delete media events or hand-edit provenance. Because this change adds no migration, code rollback is a branch/deploy rollback plus policy/schedule disablement.
