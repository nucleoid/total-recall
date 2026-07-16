# Reflection rollout runbook

Reflection is an externally scheduled, provider-neutral weekly job. Migration 031 adds restrictive storage and RLS, but does **not** enable provider calls.

## Prerequisites

1. Apply migrations through `031_memory_reflection.sql`. The migration fails if legacy rows already use the `insights` namespace; classify those rows through a separately reviewed process rather than guessing their origin.
2. Create a dedicated API key whose namespaces are exactly the approved source namespace and `insights`, whose permissions are exactly `read,reflection`, and whose access ceiling is `normal`. Do not grant `write`, `delete`, or `admin`.
3. Review and approve a `memory-reflection` policy for this deployment. Its four independent approvals cover provider/model, privacy/retention/training terms, one source namespace at `normal`, and per-run/monthly budget. Approval for embeddings or another generative feature does not apply.
4. Set `REFLECTION_POLICY_FILE`, `REFLECTION_API_KEY`, and `DEPLOYMENT_ENVIRONMENT`. Set only the credential environment variable named by the approved policy.

Example policy shape (replace every value and approval with reviewed values):

```json
{
  "version": 1,
  "feature": "memory-reflection",
  "environment": "production",
  "generation": { "provider": "approved-gateway", "model": "approved-model", "endpoint": "https://gateway.invalid/generate", "credentialEnv": "REFLECTION_GATEWAY_KEY" },
  "terms": { "reference": "review-record", "privacyApproved": true, "retentionApproved": true, "trainingApproved": true },
  "scope": { "namespaces": ["approved-low-sensitivity-source"], "accessLevel": "normal" },
  "selection": { "maxCandidates": 100, "maxInputBytes": 65536, "maxInsights": 10 },
  "budget": { "maxCallsPerRun": 2, "maxOutputBytesPerRun": 131072, "maxCostUsdPerRun": 1, "maxCostUsdPerMonth": 5, "estimatedRequestCostUsd": 0, "estimatedInputCostUsdPerMillionBytes": 0, "estimatedOutputCostUsdPerMillionBytes": 0, "monthlyControlReference": "budget-control" },
  "providerModelApproval": { "approved": true, "approvedBy": "reviewer", "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z" },
  "termsApproval": { "approved": true, "approvedBy": "reviewer", "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z" },
  "scopeApproval": { "approved": true, "approvedBy": "reviewer", "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z" },
  "budgetApproval": { "approved": true, "approvedBy": "reviewer", "approvedAt": "2026-01-01T00:00:00Z", "expiresAt": "2027-01-01T00:00:00Z" }
}
```

## Canary and schedule

```sh
npm run reflect -- --namespace approved-low-sensitivity-source --dry-run
npm run reflect -- --namespace approved-low-sensitivity-source
```

The default interval is the last completed ISO week in UTC. An operator may supply both `--window-start` and `--window-end` with explicit offsets. Normal reruns reuse a completed generation; `--force` creates a new generation. Logs are content-free.

After checking selection size and budget estimates, schedule the normal command weekly in the external scheduler. Never use an in-process timer.

## Disable and rollback

Disable the external schedule and remove the generation credential. Retain runs, insights, restrictive origin-aware RLS, and evidence links. Evidence foreign keys intentionally block hard purge until an explicit reviewed provenance teardown exists.
