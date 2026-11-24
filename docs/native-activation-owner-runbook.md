# Native feature activation owner

This framework owns scheduled **Total Recall product features**. It does not create an OpenClaw automation, model turn, task continuation, health poll, or conversation callback. The fixed Fuego controller invokes reviewed native CLIs in the existing DappNode ingestion container over `cass@10.0.0.21` with `~/.ssh/id_ed25519_dappnode`. Existing Plex, YouTube Music, daily-sync, watcher, ingestion, and ETH services remain independent and must not be changed while installing this owner.

Nothing in this branch installs, enables, starts, restarts, or schedules a unit. The supplied service template is planning-only and omits `--execute` deliberately.

## Security and execution contract

- Feature allowlist: `reflection`, `consolidation`, `session`, `entity`, `taste`, `contradiction-shadow`, `maintenance`, and `webhook`.
- There is no configurable command string. Each feature/subprofile maps to a fixed npm script and validated argument vector. Remote arguments are individually quoted and passed to local `ssh` with `execFile`; command output is never evaluated.
- Every configuration contains paths to a private remote environment file and, for generation features, a policy file plus its exact SHA-256. It contains no API keys, adapter bearer, database URL, or signing secret.
- Generation features require `adapterProfile: "openclaw-main-subscription"`. Before dispatch, the controller verifies the remote policy hash, rejects policy files larger than 64 KiB, parses the policy with the feature's native parser, verifies the configured environment and active lane scope, and derives the reservation from the native hard call bound. Embeddings remain the deployed local Qwen contract.
- Approval timestamps and references are validated but never created, extended, or rewritten by the controller.
- Reflection, consolidation, session, and entity bind one exact namespace/access-level lane through the native policy. Taste binds one category/access-level operation to the policy source namespace; its policy may authorize a broader exact namespace set for source ownership and target writes, so receipts label it `policy-broader` rather than claiming a single-namespace lane. The lane advances only after a verified native receipt.
- Queue workers are fixed to one job. Webhook uses concurrency one. Contradiction shadow has no execution profile because starting a second ingestion worker would compete with the dedicated owner; it remains blocked pending a native bounded read-only auditor.
- Kernel `flock` locks cover the global controller and the individual feature. Locks are held by open file descriptions and disappear on process death; PID files are not replayed or treated as ownership.
- Executed success is silent and recorded only in the fsynced content-free ledger. Raw stdout/stderr, source text, prompts, IDs, model output, secrets, and webhook bodies are discarded.

## Configuration

Store each file as mode `0600` under `~/.config/total-recall/native-activation/<feature>.json`. Example:

```json
{
  "version": 1,
  "feature": "session",
  "enabled": false,
  "container": "REVIEWED_EXISTING_INGESTION_CONTAINER",
  "environmentFile": "/etc/total-recall/private/session-native.env",
  "policyFile": "/app/policies/session-distillation-v1.json",
  "policySha256": "REPLACE_WITH_64_LOWERCASE_HEX",
  "policyEnvironment": "production",
  "adapterProfile": "openclaw-main-subscription",
  "timeoutSeconds": 120,
  "dailyGenerationCallCap": 6,
  "approval": {
    "reference": "OWNER_APPROVAL_REFERENCE",
    "approvedBy": "OWNER_IDENTITY",
    "approvedAt": "2026-11-24T00:00:00Z",
    "expiresAt": "2026-12-01T00:00:00Z"
  },
  "lanes": [
    { "namespace": "shared", "accessLevel": "normal", "profile": "queued-session", "mode": "once" }
  ]
}
```

The remote environment file must be mode `0400` or `0600`. It supplies the existing feature key, private adapter credential, private CA settings, deployment environment, and policy environment variable expected by that native CLI. The controller checks only permissions and fixed paths; it never reads or records secret values.

Supported subprofiles/modes:

| Feature | Subprofile | Modes | Native bound |
|---|---|---|---|
| reflection | `weekly` | `dry-run`, `run` | exact policy namespace/access lane; dry-run reserves zero, run reserves policy `maxCallsPerRun` |
| consolidation | `bounded-clusters` | `selection-only`, `preview`, `apply` | exact policy namespace/access lane; reserves `min(maxClusters, policy maxCallsPerInvocation)` outside selection-only |
| session | `queued-session` | `once` | exact policy namespace/access lane; `--once --max-jobs 1`, reserves one call |
| entity | `entity-enrichment` | `once` | exact policy namespace/access lane; one job and at most one call |
| taste | `monthly-media` | `dry-run`, `preview`, `apply` | policy source namespace plus selected access level; only preview reserves the policy's two-call validation allowance |
| contradiction-shadow | `needs-native-auditor` | `blocked` | must remain disabled; no ingestion-worker command exists |
| maintenance | `lifecycle-finalize`, `supersession-finalize` | `verify` | reviewed idempotent finalizer only |
| webhook | `delivery` | `once` | one delivery, concurrency one |

Taste and consolidation artifact paths are container paths to owner-controlled files. The controller does not create approvals or copy artifacts.

### Entity historical recovery

Historical recovery is absent by default. If specifically approved, add:

```json
"entityHistoricalRecovery": {
  "completedBefore": "2026-11-01T00:00:00Z",
  "limit": 1
}
```

The cutoff is mandatory, fixed, UTC, and in the past. Limit is 1–100; it never means “all”. The controller runs the reviewed `completed-without-links` requeue before one enrichment job. Every entity receipt deliberately reports `sourceGraphCoverage: "pending"`; a successful batch is not evidence that all historical source graphs are covered.

## Shared subscription-call reservation

Before any generation-capable feature command, the global lock atomically reserves the hard maximum derived from the hash-pinned native policy and the fixed CLI bound in `generation-budget-YYYY-MM-DD.json`. There is no operator-supplied per-run reservation. If the derived maximum exceeds the daily cap, execution fails before dispatch. The default shared cap is six calls per UTC day; the configured bound is 1–24 and must remain identical across feature owners for that day. Reservations are never refunded after dispatch, timeout, provider error, unknown CLI output, or ambiguous completion. There is no paid API fallback and no model/billing route in the controller.

The top-level `approval` is a bounded operator lease for this controller configuration. It does not create, renew, replace, or extend any provider/model, terms, scope, budget, write, backfill, or selection approval inside the native policy.

## Review and installation procedure

1. Parent reviews the exact deployed container name, native policy, policy hash, private environment path/mode, namespace/access lane, approval expiry, timer cadence, call cap, and rollback.
2. Run planning mode manually. This validates local configuration and writes a content-free `planned` receipt with `scopeBinding: "unverified"`; it performs no SSH, remote policy verification, or native invocation:

   ```sh
   node --import tsx scripts/native-activation-controller.ts \
     --config "$HOME/.config/total-recall/native-activation/session.json"
   ```

3. Install the two templates under `~/.config/systemd/user/`, but do not enable the timer. Read back the loaded unit. The base service remains planning-only.
4. Add a reviewed per-feature service drop-in that clears `ExecStart=` and repeats the exact command with `--execute`. Add a timer drop-in that clears the placeholder `OnCalendar=` and sets the approved cadence. Do not use `Persistent=true`; missed periods must not cause replay.
5. Run one manual service canary. Verify the ledger, generation reservation, native run tables, local embedding readiness, resource caps, and no overlap before enabling that one feature timer.
6. Parent separately enables the reviewed timer. Do not touch existing connector, daily-sync, ingestion, watcher, OpenClaw, or ETH units.

The unit template limits the local owner to 25% CPU, 384 MiB RAM, no swap, 64 tasks, and 150 seconds. The remote native command has its own 120-second default timeout and 15-second kill grace. Raising either limit requires another review; it must not weaken validator/ETH guards or restart a stopped worker.

## Failure-only notification and canary

On the first execution failure, the controller sends exactly:

```text
Total Recall native feature failure: feature=<feature> error=<code>. Feature is stopped until its configuration or state changes.
```

It uses the installed official command only:

```sh
openclaw message send --channel discord --target 1478120981435383808 --message ... --json
```

No raw stderr, source content, IDs, secret, or policy body is included. A CLI refusal is retained as `notification.status="refused"`; it is not bypassed through Discord credentials, HTTP, a private fork, another channel, or an OpenClaw automation. Unchanged failure fingerprints suppress another send and all feature execution until the configuration hash changes or the parent explicitly repairs the state file. Success never sends a notification.

Parent bounded live failure canary, after reviewing the real configuration:

1. First run with `--execute --notification-dry-run` and an intentionally incorrect policy hash. Confirm `policy_hash_mismatch`, one dry-run CLI receipt, zero generation reservation, and zero native CLI invocation.
2. Run the same unchanged canary again. Confirm status `blocked`, no second CLI send, and still zero native invocation.
3. For one explicitly approved live notification, repeat in a fresh canary state directory without `--notification-dry-run`. Confirm exactly one message in channel `1478120981435383808` and `notification.status="cli_accepted"`. This proves CLI acceptance, not Discord rendering; parent must read back the channel independently.
4. Restore the correct policy hash. Run planning mode only. Do not activate the native feature as part of the failure canary.

## Durable receipts and rollback

State defaults to `~/.local/state/total-recall-native-activation/`:

- `ledger.jsonl`: fsynced, content-free receipts;
- `<feature>.state.json`: next exact lane and any static failure block;
- `generation-budget-YYYY-MM-DD.json`: shared non-refundable reservations;
- `locks/`: kernel-lock files, not PID ownership records.

Rollback one feature by disabling its timer, setting `enabled:false`, and reading back both states. Do not delete the ledger or budget file, restart another service, requeue broad history, or remove policy evidence. A configuration rollback does not undo already committed native product records; use that feature's existing reviewed rollback procedure.
