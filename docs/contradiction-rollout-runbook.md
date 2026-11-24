# All-access reviewed contradiction rollout

Production contradiction synthesis is disabled by default. Generation uses only the private `openclaw-adapter` and `openclaw/total-recall-synthesis`; Qwen remains local embedding/candidate infrastructure and is never a generator. Migration 060 adds a dedicated reviewed-resolution lane. It does not classify, mutate, replay migrations, or schedule work.

## Policy and key prerequisites

Provision a supported key with the intended stored namespaces, `max_access_level=secret`, permissions `read,contradiction_resolve`, and no `write/admin/delete`. Historical memories do not require a live creator key and legacy non-UUID `client_id` provenance is preserved. Current reviewer key enabled/revoked/expiry, direct namespaces, and access ceiling are rechecked by PostgreSQL at apply/reversal.

Set the following for one exact namespace policy:

- `CONTRADICTION_CLASSIFICATION_ENABLED=true`
- `CONTRADICTION_PROCESSING_APPROVED=true`
- `CONTRADICTION_PROVIDER=openclaw-adapter`
- `CONTRADICTION_MODEL=openclaw/total-recall-synthesis`
- `CONTRADICTION_GENERATION_ENDPOINT=<private TLS adapter /v1/generate>`
- `CONTRADICTION_GENERATION_API_KEY=<dedicated adapter bearer>`
- `CONTRADICTION_PROVIDER_MODEL_APPROVED=true`
- all three privacy/retention/training approvals
- `CONTRADICTION_APPROVED_NAMESPACE=<one namespace>`
- `CONTRADICTION_APPROVED_ACCESS_LEVEL=secret`
- `CONTRADICTION_SCOPE_APPROVED=true`
- `CONTRADICTION_BUDGET_MODE=subscription`
- `CONTRADICTION_BUDGET_APPROVED=true`
- bounded `CONTRADICTION_MAX_CALLS_PER_INVOCATION`, `CONTRADICTION_MAX_INPUT_BYTES_PER_INVOCATION`, and `CONTRADICTION_MAX_OUTPUT_BYTES_PER_INVOCATION`
- a reviewed `CONTRADICTION_USAGE_CONTROL_REFERENCE`
- bounded shadow in-flight/queue limits and provider timeout
- `CONTRADICTION_REVIEW_API_KEY`, `DEPLOYMENT_ENVIRONMENT`, and `NODE_EXTRA_CA_CERTS`

Subscription mode rejects direct-provider models and never enables legacy automatic mutation, even if old auto-mutation flags are present. Its process-lifetime counters are an invocation safety bound, not a durable billing ledger or a cross-replica/cross-restart ceiling; the referenced subscription usage control remains the operator's durable limit. Legacy paid-budget parsing remains compatibility-only.

## Shadow acceptance before mutation

1. Deploy source and migration 060 with classification off.
2. Enable subscription classification with mutation off.
3. Review content-free counts for candidates, no candidates, classifications, invalid output, provider timeout/error, budget exhaustion, queue saturation, and shutdown.
4. Confirm no source revisions, validity intervals, supersession links, or content hashes changed.
5. Keep `CONTRADICTION_AUTO_MUTATION_ENABLED=false`; production mutation uses reviewed receipts only.

## Explicit preview and decision

Preview materializes 2–6 exact active semantic sources through the genuine current reviewer key. It sends bounded text to the tool-denied OpenClaw synthesis agent, but writes no source rows. The receipt contains only source IDs, revisions, content hashes, access levels, classification, policy fingerprint, and the maximum sensitivity of **all** prompt inputs.

```
npm run contradiction:review -- preview \
  --subject <proposed-successor-id> \
  --candidate <possible-predecessor-id> \
  --output receipt.json
```

Review the receipt independently. Generate an expiring decision file:

```
npm run contradiction:review -- decide --input receipt.json --decision apply \
  --approved-by <operator-ledger-id> --approved-at <UTC> --expires-at <UTC> \
  --output decision.json
```

A reject decision is durable review evidence but cannot mutate. Malformed output, unknown candidate IDs, low confidence, non-contradictions, expired approvals, policy drift, source revision/hash/lifecycle drift, key drift, and sensitivity downgrade all fail closed.

## Apply, replay, and reversal

Apply one reviewed decision:

```
npm run contradiction:review -- apply --input decision.json
```

The fixed-shape database function locks and revalidates every materialized prompt source, closes the predecessor at the already-stored successor's `valid_from`, links the successor, records content-free provenance/audit, and never rewrites either source text. Replaying the same decision returns `alreadyApplied:true`.

For a synthetic canary, use two isolated stored memories, one call, one receipt, and verify: predecessor closed; successor linked; both contents and original provenance unchanged; lower-clearance reads remain denied; raw INSERT/UPDATE/DELETE with the reviewer key fail; replay makes no new row.

Reversal input is owner-created mode-0600 JSON containing the returned `resolutionId` and original `decisionFingerprint`:

```
npm run contradiction:review -- reverse --input reversal.json
```

Reversal never reopens or deletes immutable history. It closes the reviewed successor and appends a restoration revision copied from the preserved predecessor, linked after the successor. Local embedding capture queues the restored row. Reversal refuses if later history already depends on the successor.

## Native read-only auditor

Migration 062 provides a separate, append-only shadow claim/outcome ledger for the scheduled native auditor. This auditor is not another ingestion worker and never resolves or mutates a memory. Its dedicated key must currently authorize exactly `read,contradiction_resolve`, one approved namespace, and `normal` access.

Each `--once` invocation considers only the latest 50 current semantic memories backed by the active Qwen manifest contract, chooses one subject and at most five candidates, and makes at most one call through `openclaw/total-recall-synthesis`. It creates no embeddings and performs no corpus walk or historical backfill. Claims are unique by subject revision, approved policy hash, and evidence hash; unchanged evidence cannot retry. No-candidate claims are durably recorded with zero provider calls.

The controller command is fixed:

```sh
npm run contradiction:audit -- --once --namespace EXACT_NAMESPACE \
  --access-level normal --expected-policy-hash RUNTIME_POLICY_FINGERPRINT_SHA256
```

The CLI recomputes the approved runtime policy fingerprint before passing its hexadecimal hash to PostgreSQL; the imported fingerprint's NUL separators never reach a PostgreSQL text parameter. Receipts expose only fixed status, call count, classification/confidence, and hashes—never source text, candidate IDs, prompts, or model output. Apply only pending migration 062 through the migration ledger after 061; do not replay migrations or activate a timer as part of migration installation.

## Rollback

1. Stop new previews/applies and drain in-flight provider calls.
2. Disable classification; leave automatic mutation off.
3. Reverse only individually reviewed resolutions whose successor has no later history.
4. Retain migration 060, resolution receipts, source history, and audit rows.
5. Never delete source history, forge auth context, grant broad writer/admin rights, or use Qwen as generation fallback.
