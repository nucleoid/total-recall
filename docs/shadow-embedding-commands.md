# Shadow embedding operator commands

These commands are nonproduction scaffolding for the Qwen shadow index. They do not authorize a deployment, download a model, call a provider, certify completion, or cut traffic over. Every command requires an explicit `SHADOW_EMBEDDING_DATABASE_URL` and `--database`; `DATABASE_URL` and dotenv files are never consulted. The database role must be a superuser or have `BYPASSRLS`, and `--database` must equal `current_database()`.

Run commands from the repository checkout with `node --import tsx scripts/shadow-embeddings.ts ...`.

## Operational manifest

All mutations require `--apply`, `--manifest <path>`, and `--manifest-sha256 <canonical-sha256>`. The hash is the SHA-256 of the manifest's recursively key-sorted compact JSON form. The manifest itself must contain a real approval record with a nonempty reference, the SHA-256 of that separately retained approval artifact, approver identity, and timestamp. A placeholder or generated approval is not acceptable.

```json
{
  "version": 2,
  "approval": {
    "reference": "ops/change-record-actual-reference.json",
    "sha256": "<sha256 of the retained approved record>",
    "approvedBy": "<actual operator identity>",
    "approvedAt": "<ISO-8601 timestamp>"
  },
  "source": { "releaseSha": "<40 lowercase hex Git release SHA>" },
  "eligibility": {
    "predicate": "deleted_at IS NULL AND superseded_at IS NULL\n  AND consolidated_into_id IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())\n  AND (valid_from IS NULL OR valid_from <= statement_timestamp())\n  AND (valid_to IS NULL OR valid_to > statement_timestamp())",
    "namespaces": "all",
    "includeNullVectors": true,
    "activeSubscriptions": true
  },
  "resources": {
    "maxParentsPerBatch": 20,
    "maxSourceBytesPerBatch": 1000000,
    "maxTokensPerBatch": 100000,
    "maxElapsedMsPerBatch": 60000,
    "maxAttempts": 3,
    "indexBuild": {
      "maintenanceWorkMemMb": 256,
      "maxParallelMaintenanceWorkers": 1,
      "lockTimeoutMs": 2000,
      "statementTimeoutMs": 600000
    },
    "host": {
      "deploymentProfile": "linux-worker",
      "expectedHostname": "<exact executing Linux hostname>",
      "diskPath": "/srv/total-recall",
      "minAvailableMemoryBytes": 4294967296,
      "minAvailableDiskBytes": 107374182400,
      "maxLoadPerCpu": 1,
      "maxSwapUsedBytes": 134217728,
      "maxMemoryPsiAvg10": 1,
      "maxCpuPsiAvg10": 5
    }
  },
  "runtime": {
    "acceptanceReceiptSha256": "<real runtime acceptance receipt SHA-256>",
    "artifactSha256": "b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d",
    "runtimeContract": "llama.cpp/b11669/last-pool/tokenize-special/native2560",
    "expectedRuntimeHost": "<actual accepted inference hostname>",
    "expectedRuntimeMode": "cpu",
    "tls": {
      "caSha256": "<approved private CA file SHA-256>",
      "spkiSha256": "<approved server public-key SPKI SHA-256>"
    }
  },
  "backfill": {
    "provider": "openrouter",
    "model": "qwen/qwen3-embedding-4b",
    "providerName": "DeepInfra",
    "endpoint": "https://openrouter.ai/api/v1/embeddings",
    "maxConcurrency": 1
  },
  "steadyState": {
    "resources": {
      "maxParentsPerBatch": 5,
      "maxSourceBytesPerBatch": 1000000,
      "maxTokensPerBatch": 100000,
      "maxElapsedMsPerBatch": 900000,
      "maxAttempts": 3,
      "indexBuild": {
        "maintenanceWorkMemMb": 256,
        "maxParallelMaintenanceWorkers": 1,
        "lockTimeoutMs": 2000,
        "statementTimeoutMs": 600000
      },
      "host": {
        "deploymentProfile": "linux-worker",
        "expectedHostname": "<exact steady-worker Linux hostname>",
        "diskPath": "<reviewed persistent disk path>",
        "minAvailableMemoryBytes": 8589934592,
        "minAvailableDiskBytes": 107374182400,
        "maxLoadPerCpu": 1,
        "maxSwapUsedBytes": 12884901888,
        "maxMemoryPsiAvg10": 1,
        "maxCpuPsiAvg10": 5
      }
    },
    "runtime": {
      "acceptanceReceiptSha256": "<real CPU serving acceptance receipt SHA-256>",
      "artifactSha256": "b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d",
      "runtimeContract": "llama.cpp/b11669/last-pool/tokenize-special/native2560",
      "expectedRuntimeHost": "<actual accepted CPU serving hostname>",
      "expectedRuntimeMode": "cpu",
      "tls": {
        "caSha256": "<approved CPU serving private CA file SHA-256>",
        "spkiSha256": "<approved CPU serving public-key SPKI SHA-256>"
      }
    }
  }
}
```

The semantic target separately uses [the upstream NFC v2 contract](openrouter-nfc-contract.md): canonical source bytes remain raw, while tokenization and inference are NFC. Old raw-profile vectors and runtime receipts cannot be relabeled.

Version 2 requires the pinned `backfill` block. The worker reads `OPENROUTER_API_KEY` only from its protected environment, fixes routing to DeepInfra, disables provider fallback, and uses the accepted local runtime only for exact tokenization during cloud backfill. `steadyState` is optional for preparation and backfill compatibility, but activation and completion fail closed without it. It repeats the full resource/runtime schemas so the same immutable manifest independently pins cloud backfill, matching local tokenization, and CPU steady serving. It contains no second approval object. Its runtime mode must be `cpu`; arbitrary local runtime/model identities are rejected by the same validator. Do not create the manifest until its approval, both runtime acceptances, source release, resource bounds, and eligibility have been reviewed. The command validates these pins but cannot prove that an external approval artifact exists.

## Inference gateway installation

`scripts/local-embedding-gateway.ts` requires `SHADOW_EMBEDDING_GATEWAY_CONFIG`,
`SHADOW_EMBEDDING_GATEWAY_CONFIG_SHA256` (the raw file bytes, not canonical JSON),
`SHADOW_EMBEDDING_GATEWAY_KEY_FILE`, and `SHADOW_EMBEDDING_BACKEND_PORT`. Its
`GatewayReceipt` schema is defined in `src/local-embedding-gateway.ts`. Install only
the reviewed model and native runtime bundle, retaining file hashes and the actual
runtime acceptance receipt. The manifest includes all loadable DLL/EXE/SO files
and the configured extensionless Linux executable; confined SO symlinks are allowed.
Record the OS/container image, GPU driver and system dependency versions alongside
the bundle receipt. Hashing the launcher alone does not identify its backend.

All gateway modes require host RAM, disk, swap and CPU limits. GPU mode additionally
requires the exact device UUID, thermal readings below 85°C and free VRAM bounds.
Linux CPU mode also checks memory PSI. Windows uses measured CPU counters and
bounded pagefile telemetry, and fails closed when those counters are unavailable.
CPU preflight and GPU launches are finite; CPU launches beyond 15 minutes require
explicit persistent approval. Authorization expiry stops the owned child.

Linux artifact paths must have trusted owners and no group/world write permissions.
Windows artifacts are confined to the current user's protected profile: every
ancestor must prevent other principals from modifying or replacing them. Keys and
configuration additionally deny other principals read access. Backend key directories
are protected before a key is written; shared writable Temp directories are not used
for Windows backend keys. The gateway does not change ACLs on existing model files.

Remote listeners require private IPv4, a pinned TLS certificate, a protected private
key and an exact peer-address allowlist. Clients and health checks use scoped TLS
transport with an approved CA-file SHA-256 and peer SPKI SHA-256. The operational
manifest pins these hashes; the host-local runtime JSON additionally supplies
`tls.caPath`. Standard certificate-chain and hostname validation remain enabled.
Loopback HTTP preflight has no TLS object. No system trust-store or global TLS
verification setting is changed. Private listener installation and availability
changes belong in the consolidated operational approval.

## Prepare and inventory

Prepare creates the immutable Qwen contract, its dedicated vector partition, and an immutable run in `prepared` state. Capture remains disabled at this point.

```powershell
$env:SHADOW_EMBEDDING_DATABASE_URL = '<operator PostgreSQL URL>'
node --import tsx scripts/shadow-embeddings.ts prepare --database <expected-db> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

Record the returned run UUID. Inventory is deliberately page bounded. A short run-locked transaction enables capture and commits before opening the inventory page transaction. Writers after that commit are queued; earlier committed rows are visible to the subsequent scan. Each page inserts eligible parents from every namespace, regardless of existing or NULL vectors, or active subscription queries, and commits its cursor with those inserts. Repeat until `inventory_complete` is true:

```powershell
node --import tsx scripts/shadow-embeddings.ts inventory-page --database <expected-db> --run-id <uuid> --limit 500 --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

An interrupted page rolls back both inserts and cursor. Repeating it is idempotent. Trigger capture protects parents inserted or changed after capture is enabled. Inventory completion only means the bounded initial keyset scan ended; it is not corpus completion or convergence.

Preparation refuses `embedding.capture_already_enabled`. The current schema has one queue per contract rather than one queue per run, so starting a second run for the same contract after capture begins would ambiguously reuse the first run's work. Resume the original immutable run. A future requirement for a distinct rerun needs a schema design and migration; operators must not disable capture to bypass this guard.

## Lifecycle and retries

Start is refused until inventory is complete. Pause and resume retain the same immutable run and manifest.

```powershell
node --import tsx scripts/shadow-embeddings.ts start  --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
node --import tsx scripts/shadow-embeddings.ts pause  --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
node --import tsx scripts/shadow-embeddings.ts resume --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

Failed items stay visible. Requeue requires an exact, bounded list and only works while the run is prepared or paused; every requested ID must currently be failed or the transaction rolls back.

```powershell
node --import tsx scripts/shadow-embeddings.ts requeue --database <expected-db> --run-id <uuid> --parent-type memory --parent-id <uuid> --parent-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

The separate index CLI provides a guarded completion action, described below. Ledger success counts cannot establish completion. Completion still needs mutation convergence, an independent full audit at a coordinated watermark, writer/runtime coverage, quality and retrieval acceptance, restore-tested backup, capacity evidence, cutover approval, canaries, and observation.

## Read-only inspection

Status reports all work states, including failed and retry items, plus namespace coverage and recent runs. Audit independently checks stored manifests and chunks in bounded repeatable-read pages. Neither command needs `--apply` or a manifest.

```powershell
node --import tsx scripts/shadow-embeddings.ts status --database <expected-db>
node --import tsx scripts/shadow-embeddings.ts audit-page --database <expected-db> --limit 100
node --import tsx scripts/shadow-embeddings.ts audit-page --database <expected-db> --limit 100 --cursor <last-parent-uuid>
```

The worker runs exactly one finite batch using the immutable manifest limits. It requires the run to be `running`, the persisted run manifest and release to match the supplied approved manifest, and these explicit variables: `SHADOW_EMBEDDING_URL`, `SHADOW_EMBEDDING_API_KEY`, and `SHADOW_EMBEDDING_RUNTIME_JSON`. The runtime JSON must contain the pinned contract, artifact, runtime contract, and real acceptance receipt hash. No dotenv or fallback configuration is loaded.

For HTTPS, the runtime JSON must also contain `tls.caPath`, `tls.caSha256`, and `tls.spkiSha256`. The two hashes must equal the approved manifest TLS hashes. The scoped client verifies the retained CA bytes, normal hostname and certificate-chain validation, and the peer SPKI on every connection. Loopback HTTP omits `tls`; remote HTTP and unpinned HTTPS fail closed.

```powershell
node --import tsx scripts/shadow-embeddings.ts worker --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

Before work and again before model inference, the worker verifies the exact Linux hostname, available RAM and disk, one-minute load per CPU, swap use, memory PSI, CPU PSI, and an authenticated `/health` response carrying the pinned runtime identity. Missing `/proc` PSI or other unknown metrics fail closed. `linux-worker` is the normal deployment profile. `linux-transient-laptop` must be explicitly approved in the immutable manifest and is additionally capped at 100 parents and 15 minutes per invocation; it does not authorize a stable serving deployment. The example thresholds are illustrative and must be replaced by reviewed host-specific limits.

## Steady-state repair worker

Capture continues after initial convergence. Future-valid parents, asynchronous writers and later source/lifecycle mutations therefore need a durable CPU worker during observation and after run completion. The steady commands use the immutable `steadyState` CPU runtime/resources from the original run manifest; they never substitute the cloud backfill plan or rewrite the manifest.

After cutover activation, explicitly enable the steady fence. One invocation processes exactly one finite batch. The illustrative plan above permits 5 parents, 1 MiB source, 100,000 tokens, 15 minutes and 3 retryable attempts. Validate its duration against representative long parents on the accepted CPU runtime before approval; this is a finite process lifetime, not a service-wide deadline:

```powershell
node --import tsx scripts/shadow-embeddings.ts steady-enable --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
node --import tsx scripts/shadow-embeddings.ts steady-worker --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
node --import tsx scripts/shadow-embeddings.ts steady-pause --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

The gateway's exact authenticated HTTP 429 `{"error":"busy"}` response represents single-slot contention. A worker ends the finite invocation without pausing the run; an already claimed item is deferred with its attempt count unchanged. Supervisors retain their bounded idle/backoff cadence. Other health, resource and identity failures keep the existing fail-closed pause behavior.

Enable and pause lock the same attested serving/run binding. A steady invocation requires run state `paused` or `complete`, the serving singleton to reference the same immutable cutover attestation/run, capture enabled, and `steady_worker_enabled=true`. The store repeats these fences during claims and publication. Missing serving state, a rollback, a disabled flag, wrong runtime receipt/TLS identity, or a systemic/fatal resource error stops work; there is no fallback to cloud-backfill settings.

The permanent worker supervisor invokes only this finite command against the accepted CPU serving gateway. It must prevent overlap, poll no faster than every 5 seconds while actionable work exists, back off to at least 30 seconds when idle, and preserve process/receipt visibility. Before the five-minute cutover or observation-end drain, stop the timer and run `steady-pause`; after activation or the final target-only canaries, re-enable it. Following guarded run completion it remains enabled for future mutations. Installation must use the reviewed immutable release, explicit operator database URL, manifest/hash/run ID and protected CPU runtime environment; dotenv and `DATABASE_URL` fallback remain forbidden.

## Index build and completion attestation

Partition creation does not silently build a long-running index. Inspect first, then run the separately approved partition-local concurrent build while the run is prepared or paused. The build uses only the immutable manifest's bounded maintenance memory, parallel-worker, lock-timeout, and statement-timeout values. An interrupted invalid index fails closed for operator inspection rather than being dropped automatically.

```powershell
node --import tsx scripts/shadow-embedding-index.ts inspect --database <expected-db>
node --import tsx scripts/shadow-embedding-index.ts build --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash>
```

Initial cutover uses a second, independently hashed JSON file so its exact audit watermark, evidence, observation window, and rollback budget cannot be changed at the command line. Its `approval` object must exactly equal the operational manifest approval. This explicit reuse is valid only when that retained approval artifact actually covers the full job, cutover, observation window, and rollback bounds; the tool does not treat an earlier general approval as blanket cutover authority.

```json
{
  "version": 2,
  "contractId": "91e3bb787cf8c10c8dcd2e1a724d3b18acfc03a1ea063ee920548e99e7b95d97",
  "runId": "<run UUID>",
  "operationalManifestSha256": "<operational manifest hash>",
  "watermark": "<coordinated audited ISO-8601 instant>",
  "evidence": {
    "auditReceiptSha256": "<sha256>",
    "qualityReceiptSha256": "<sha256>",
    "backupReceiptSha256": "<sha256>"
  },
  "activation": {
    "observationEndsAt": "<ISO-8601, after watermark and at most 30 days later>",
    "rollbackWritesEnabled": true,
    "rollbackInputsPerMinute": 10,
    "rollbackUntil": "<ISO-8601, after watermark, no later than observation end, at most 7 days later>"
  },
  "approval": { "reference": "<same retained approval reference>", "sha256": "<same approval artifact sha256>", "approvedBy": "<operator>", "approvedAt": "<ISO-8601>" }
}
```

After the independent audit produces the real watermark and receipts, attest it, then activate initial serving. Both commands recalculate database coverage; attestation also invokes the database's immutable full integrity guard. Activation is insert-only and refuses an existing serving row. A concurrent later source change is captured and makes affected scopes fail closed until current target data is published.

```powershell
node --import tsx scripts/shadow-embedding-index.ts attest-cutover --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash> --cutover-plan <cutover.json> --cutover-plan-sha256 <hash>
node --import tsx scripts/shadow-embedding-index.ts activate --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash> --cutover-plan <cutover.json> --cutover-plan-sha256 <hash>
```

Automatic search checks database serving mode before provider work. After inference it takes a shared transaction advisory lock, rechecks the mode, and holds that lock through ranking. Supported activation and rollback take the matching exclusive lock before their run/settings row locks. A missing or inconsistent target environment fails closed; explicit evaluator vectors bypass automatic provider and serving-mode selection. All writers and readers must still be drained for cutover.

Emergency rollback is supported only inside the approved dual-write window. Hard-stop and drain every process, job, scheduler, and direct database client that can write memories before running SQL. The separately reviewed, content-free rollback evidence receipt must attest that all writers were stopped and drained and that the current Gemini rollback plane was verified; possessing a receipt hash alone is not proof of either condition. Then run the exact approved cutover plan:

```bash
node --import tsx scripts/shadow-embedding-index.ts rollback --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash> --cutover-plan <cutover.json> --cutover-plan-sha256 <hash> --reason '<reviewed reason>' --rollback-evidence-sha256 <sha256>
```

The command locks the serving setting against writers already inside the mutation trigger, verifies every eligible memory changed during the observation window still has its recorded current Gemini vector, records an immutable rollback receipt, and removes the serving row atomically. The SQL transaction does not stop application processes, readers, schedulers, or a writer that begins after the serving row is removed. After it commits, remove `SHADOW_EMBEDDING_CURRENT_CONTRACT` and `SHADOW_EMBEDDING_ROLLBACK_WRITES`, restart every writer and reader on the reviewed release, and verify Gemini serving before resuming writes. Rows untouched since cutover remain covered by the separately retained pre-cutover Gemini snapshot; the mutation ledger does not relabel unknown historical vectors.

Completion is accepted only from a paused, fully inventoried run with a valid ready HNSW index, no failed or actionable queued work, complete current memory manifests, valid active subscription targets, and no pending eligible insertion events. The attestation JSON must contain real SHA-256 receipts named `qualityReceiptSha256`, `auditReceiptSha256`, `backupReceiptSha256`, and `cutoverApprovalSha256`. The watermark is an explicit coordinated cutover instant.

```powershell
node --import tsx scripts/shadow-embedding-index.ts complete --database <expected-db> --run-id <uuid> --apply --manifest <manifest.json> --manifest-sha256 <hash> --attestation <completion.json> --cutover-watermark <ISO-8601>
```

This guard cannot prove the evidence represented by those hashes is substantively adequate. Operators must retain and independently review the referenced receipts.

## Frozen quality pilot duration

The quality pilot keeps a 120-second whole-run operational deadline by default. That deadline includes deterministic token planning, document inference, and the frozen 48-query evaluation. An operator may supply `--max-duration-ms <120000..900000>` only when a longer finite duration has been justified by measured, content-free sizing and approved for this pilot before execution. The configured maximum and actual elapsed milliseconds are recorded in the pilot report.

```powershell
node --import tsx scripts/eval-shadow-pilot.ts --input <frozen-pilot.json> --output <new-report.json> --expected-corpus-hash <sha256> --expected-judgments-hash <sha256> --baseline-receipt-sha256 <sha256> --approval-reference <reference> --pseudonym-key-file <restricted-key-file> --max-duration-ms 600000
```

The option changes only the operational deadline. Corpus, judgment, baseline receipt, token and vector limits, categories, recall/MRR thresholds, negative gates, and runtime token verification remain unchanged. `pilot.operational_time_budget` is an operational failure, separate from a completed quality evaluation whose report has `passed: false`. Never automatically retry a timed-out pilot or increase its duration after the timeout. Review the measurement and obtain the required approval first. Select the actual budget only after the content-free sizing receipt is available; the example value above is illustrative.

In the frozen quality judgments, `forbiddenParentIds` names semantic distractors for hard-negative cases. A hard-negative ordering violation occurs only when the highest-ranked labeled distractor outranks the highest-ranked expected positive. The existing rank order resolves equal scores deterministically by parent ID; there is no additional score-margin threshold. The pilot requires zero such ordering violations alongside the unchanged recall, MRR, regression, critical, and boundary gates. This definition was fixed before any real judgments or model rankings existed and must not be retuned after results.

Semantic distractors are not an ACL or lifecycle mechanism. The separate ACL/lifecycle acceptance evidence must prove that unauthorized and ineligible rows never appear in results; a distractor may legitimately appear below the correct result when it is itself authorized and lifecycle eligible.

For local verification, never point tests at `DATABASE_URL` or a production database. Use the isolated integration helper and `SHADOW_EMBEDDING_TEST_DATABASE_URL` where available. Type-check with:

```powershell
node node_modules/typescript/bin/tsc --project tsconfig.scripts.json --noEmit
```
