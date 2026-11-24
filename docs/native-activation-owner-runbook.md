# Native feature activation owner

This framework owns scheduled **Total Recall product features**. It does not create an OpenClaw automation, model turn, task continuation, health poll, or conversation callback. The fixed Fuego controller invokes reviewed native CLIs in the existing DappNode ingestion container over `cass@10.0.0.21` with `~/.ssh/id_ed25519_dappnode`. Existing Plex, YouTube Music, daily-sync, watcher, ingestion, and ETH services remain independent and must not be changed while installing this owner.

Nothing in this branch installs, enables, starts, restarts, or schedules a unit. The supplied service template is planning-only and omits `--execute` deliberately.

## Security and execution contract

- Feature allowlist: `reflection`, `consolidation`, `session`, `entity`, `taste`, `contradiction-shadow`, `maintenance`, and `webhook`.
- There is no configurable command string. Each feature/subprofile maps to a fixed npm script and validated argument vector. Remote arguments are individually quoted and passed to local `ssh` with `execFile`; command output is never evaluated.
- Every configuration contains paths to a private remote environment file and, for generation features, a policy file plus its exact SHA-256. It contains no API keys, adapter bearer, database URL, or signing secret.
- Generation features require `adapterProfile: "openclaw-main-subscription"`. Their native policy parser remains authoritative for the private endpoint, exact OpenAI subscription model, current approval, scope, and no-paid-fallback rules. Embeddings remain the deployed local Qwen contract.
- Approval timestamps and references are validated but never created, extended, or rewritten by the controller.
- One exact namespace/access-level lane runs per invocation. The lane advances only after a verified native receipt. No archive import, corpus walk, or broad replay profile exists.
- Queue workers are fixed to one job. Contradiction shadow and webhook also use concurrency one. The default inner timeout is 120 seconds.
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
  "adapterProfile": "openclaw-main-subscription",
  "timeoutSeconds": 120,
  "dailyGenerationCallCap": 6,
  "generationCallsPerRun": 1,
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
| reflection | `weekly` | `dry-run`, `run` | one exact namespace/window selected by native CLI |
| consolidation | `bounded-clusters` | `selection-only`, `preview`, `apply` | max anchors 100, max clusters 10; preview/apply retain native approvals |
| session | `queued-session` | `once` | `--once --max-jobs 1` |
| entity | `entity-enrichment` | `once` | one generated job |
| taste | `monthly-media` | `dry-run`, `preview`, `apply` | one category and access level; approved selection required for apply |
| contradiction-shadow | `ingestion-shadow` | `shadow` | one ingestion job, concurrency/batch size one; mutation remains policy-gated off |
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

Before any generation-capable feature command, the global lock atomically reserves its configured call allowance in `generation-budget-YYYY-MM-DD.json`. The default shared cap is six calls per UTC day; the configured bound is 1–24 and must remain identical across feature owners for that day. Reservations are never refunded after dispatch, timeout, provider error, unknown CLI output, or ambiguous completion. There is no paid API fallback and no model/billing route in the controller.

## Review and installation procedure

1. Parent reviews the exact deployed container name, native policy, policy hash, private environment path/mode, namespace/access lane, approval expiry, timer cadence, call cap, and rollback.
2. Run planning mode manually. This validates local configuration and writes a content-free `planned` receipt but performs no SSH or native invocation:

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
