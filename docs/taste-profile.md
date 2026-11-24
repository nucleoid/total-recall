# Media taste profiles

Taste profiles turn bounded `media_events` aggregates into monthly memories. Activation is subscription-only and fail-closed: generation is accepted only through the private OpenClaw adapter with provider `openclaw-adapter`, model `openclaw/total-recall-synthesis`, and budget mode `subscription`. There is no USD estimate or paid-provider fallback. Embeddings continue to use the active Qwen embedding contract.

## Evidence and sensitivity lanes

Only semantically relevant media evidence is materialized. Broad authorization for `financial`, secret My Life material, or other namespaces does **not** make those records taste evidence. Eligible music and viewing events are separated by explicit predicates.

Each run uses one exact `normal`, `sensitive`, or `secret` lane. An unlinked media event is normal. A linked event inherits the linked memory's access level. Aggregation, preview, source fingerprint, and stored output stay in that exact lane. The output access level is therefore the maximum classification of every materialized input, including evidence not selected by the model. Lanes have independent source keys and supersession chains.

The provider receives only bounded aggregate facts: category, month, accepted counts, bounded services/artists/shows/titles/genres, time-window context, qualified trends, and content-free quality warnings. It never receives raw events, IDs, timestamps, credentials, source keys, ownership IDs, memory text, or control metadata. It can return only a four-value style and supplied evidence IDs; profile prose is rendered locally.

Local provenance records the worker owner, all event-owner and linked-memory-owner key IDs, source/target namespace, linked-memory revision/classification, lane, materialized event count, aggregate hash, source fingerprint, policy hash, selection time/approval, adapter model, and active embedding descriptor. Before apply, the implementation re-reads every materialized source, each source-owner key, the worker key, policy, and aggregate. Changed, missing, deleted, expired, superseded, out-of-scope, or revoked inputs fail without mutation.

## Policy and key requirements

Policy version 2 requires:

- exact adapter provider/model above and the private adapter endpoint/credential variable;
- separately unexpired provider/model, terms, scope, and subscription-usage approvals;
- the complete authorized namespace list, source/target namespace, and enabled lanes;
- exactly two bounded preview attempts, 8192 total output bytes, an external subscription-usage control reference;
- preview TTL (1–1440 minutes) and a local materialization cap.

The runtime key must be genuine, enabled, unexpired, unrevoked, and have:

- namespaces **exactly equal** to policy `scope.namespaces`, containing only the approved source, target, and any namespace needed by linked source memories;
- `max_access_level` exactly equal to the highest enabled lane (`secret` when all lanes are enabled);
- permissions exactly `read,taste_profile`, with no ordinary `write`, `admin`, ingestion, delete, or scheduler permissions.

Migration 058 provides the only cross-owner lane: bounded SECURITY DEFINER functions validate each existing event owner and linked-memory owner as live, readable, namespace-authorized, and sufficiently classified. Forward migration 063 repairs the existing-profile update branch by disambiguating its local agent identifier; it does not replay or weaken 058. Restrictive RLS policies deny the worker raw `media_events`, `memories`, `agents`, and `audit_log` access. Created and updated profiles plus their agent/audit provenance remain owned by the worker key; connector `client_id` values are never forged or rewritten.

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
    "namespaces": ["media", "personal"],
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
  "budgetApproval": { "approved": true, "approvedBy": "owner", "approvedAt": "...", "expiresAt": "..." },
  "standingAutomation": {
    "enabled": true,
    "ownerInstruction": {
      "reference": "private owner instruction record",
      "effectiveAt": "..."
    },
    "operator": {
      "identity": "service:taste-profile-recurring",
      "authorizationReference": "private operator authorization record",
      "authorizedAt": "...",
      "expiresAt": "..."
    }
  }
}
```

`standingAutomation` is optional and absent by default. Manual dry-run, preview, and apply do not require it. The referenced owner instruction persists until the private policy is disabled/replaced; the implementation does not invent an owner expiry or require monthly reapproval. The automation operator is separate and must have a currently effective bounded lease (for example, 90 days). Never represent the service identity as the owner.

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

## Standing reviewed automation

With an explicit effective `standingAutomation` block, the recurring composite performs the same review pipeline without a new selection file each month:

```sh
npm run taste-profile -- --category all --access-level all --run-reviewed
```

For each exact category/access lane, `--run-reviewed` first checks for an unchanged existing profile. An unchanged replay returns without provider or embedding calls. Otherwise it runs the existing bounded preview (at most two provider attempts total), validates the fixed style/evidence-ID schema, and renders the profile locally. It then creates a short-lived approval receipt attributed to the configured automation service and private authorization references—not to a fabricated human identity—and passes that receipt through the existing apply path. Apply itself makes zero provider calls and rechecks the current key, policy, source fingerprint, aggregate, source-owner authorization, linked-memory lifecycle/classification, approval windows, and Qwen embedding contract before mutation.

Stored provenance includes the approval mode, operator identity, operator authorization reference, owner-instruction reference, receipt expiry, and policy hash. The policy hash binds the persistent owner instruction and separate operator lease. Raw source IDs, ownership IDs, credentials, memory text, and private authority references are never added to model input. Manual preview/apply remains unchanged.

The isolated PostgreSQL authority acceptance test exercises successful sensitive- and secret-lane derivation with genuine hashed worker, connector, linked-memory, and reader keys. It verifies worker ownership of derived memories, unchanged connector ownership, current event-owner and linked-memory-owner provenance, changed-evidence update, replay idempotence, and normal-reader isolation from protected results. Source drift or owner-authority revocation between review and apply leaves the prior profile and audit history unchanged. It also rechecks that the taste worker cannot directly read raw memories, media events, agents, or audit rows after protected-lane writes.

## Rollback

Disable/remove the external schedule, remove `TASTE_PROFILE_POLICY_FILE` and the adapter credential, and disable/revoke the taste key. Existing profile memories remain lifecycle-managed records. Use supported memory lifecycle operations to retire a bad profile; do not delete media events or hand-edit provenance. Code rollback is a branch/deploy rollback plus policy/schedule disablement; migrations 058 and 063 are additive and may remain installed while the key is disabled.
