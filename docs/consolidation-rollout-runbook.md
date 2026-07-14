# Memory consolidation rollout (#54)

Memory consolidation is an externally scheduled, bounded maintenance command. It is not an MCP tool, REST operation, or in-process timer. The shipped default is disabled: without a feature-specific policy file, only `--selection-only` can run.

## Safety model

- Initial scope is exactly one explicitly requested namespace at `access_level=normal`.
- Only active, current, unlinked semantic memories without a document or source key and in the exact current embedding space are candidates.
- Deterministic complete-link groups use cosine similarity `>= 0.92`; every pair must pass. Groups over 20 are skipped rather than split.
- Originals are never rewritten or deleted. Apply inserts a `memory_kind=consolidation` canonical, records immutable membership history, and sets the active provenance link atomically.
- Ordinary reads and maintenance hide linked originals. Direct ID recall retains `consolidated_into_id` and `consolidated_at`.
- Restrictive foreign keys prevent purging either side of historical provenance.

## Deployment order

1. Take and verify a restorable backup.
2. Complete migrations/finalizers 024–026 and deploy migration 027.
3. Deploy every server, stdio process, watcher, preseed path, and maintenance command with link-aware code. Do not enable writes while an old reader/writer remains.
4. Create a dedicated API key scoped to one namespace with `max_access_level=normal` and explicit `read,write,delete,consolidate` permissions.
5. Run credential-free selection:

   ```sh
   CONSOLIDATION_API_KEY=... DEPLOYMENT_ENVIRONMENT=production \
     npm run consolidate -- --namespace approved-low-sensitivity --selection-only
   ```

6. Confirm the exact-scope readiness report has zero unknown and foreign embedding identities.
7. Separately approve #54's provider/model, privacy/retention/training terms, exact namespace, dedicated credential, per-invocation limits, external monthly quota/ledger, and generation expiry. Approval for contradiction detection or embeddings does not carry over.
8. Install an owner-only strict version-1 policy and review an owner-only preview:

   ```sh
   npm run consolidate -- --namespace approved-low-sensitivity \
     --dry-run --max-clusters 2 --preview-output /owner-only/consolidation-preview.json
   ```

9. Add a separate unexpired `writeApproval` to the policy, apply one capped batch, and verify search/list/recall, audit, decay, re-embedding, forget/purge blocking, and deconsolidation.
10. Only then add operator-owned cron/systemd/Task Scheduler invocation. Each command remains bounded; no schedule is installed by this repository.

## Policy shape

The JSON file is strict: unknown fields fail. This illustrative shape omits real approvals and values:

```json
{
  "version": 1,
  "feature": "memory-consolidation",
  "environment": "production",
  "generation": {
    "provider": "reviewed-gateway",
    "model": "reviewed-model",
    "endpoint": "https://approved.example/v1/generate",
    "credentialEnv": "CONSOLIDATION_GENERATION_API_KEY"
  },
  "terms": {
    "reference": "approved-record-id",
    "privacyApproved": true,
    "retentionApproved": true,
    "trainingApproved": true
  },
  "scope": { "namespaces": ["approved-low-sensitivity"], "accessLevel": "normal" },
  "budget": {
    "maxCallsPerInvocation": 10,
    "maxInputBytesPerInvocation": 655360,
    "maxOutputBytesPerInvocation": 163840,
    "maxCostUsdPerInvocation": 1,
    "estimatedRequestCostUsd": 0.001,
    "estimatedInputCostUsdPerMillionBytes": 1,
    "estimatedOutputCostUsdPerMillionBytes": 4,
    "monthlyControlReference": "provider-project-quota-or-approved-ledger"
  },
  "generationApproval": {
    "approved": true,
    "approvedBy": "owner",
    "approvedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-02-01T00:00:00Z"
  },
  "writeApproval": {
    "approved": true,
    "approvedBy": "owner",
    "approvedAt": "2026-01-02T00:00:00Z",
    "expiresAt": "2026-02-01T00:00:00Z"
  }
}
```

Dry-run performs no DB mutation and therefore cannot enforce a cross-process monthly total. The approved provider project/account quota or external ledger named by policy is authoritative.

## Deconsolidation and rollback

Preview is the default and writes an exclusive owner-only manifest:

```sh
npm run deconsolidate -- --namespace approved-low-sensitivity \
  --canonical-id <uuid> --manifest /owner-only/deconsolidation.json
```

After reviewing the exact IDs, revisions, content-free hashes, and printed policy hash, apply with the exact hash:

```sh
npm run deconsolidate -- --namespace approved-low-sensitivity --apply \
  --manifest /owner-only/deconsolidation.json --approve-policy-hash <64-hex-hash>
```

Apply closes membership intervals, clears active links, tombstones the obsolete canonical, and audits the restoration atomically. Deleted or superseded members remain hidden. A later rebuild is explicit and creates a new canonical/history interval.

Rollback order is: stop external scheduling, remove write/generation approval, retain migration 027 and all link-aware predicates, then use only reviewed deconsolidation manifests where visibility must be restored. Never clear links ad hoc, delete provenance, disable constraints, or deploy an old reader while active memberships exist.
