# Local embedding writer and consumer matrix

This static inventory covers the current branch. It contains paths and operational metadata only; it does not establish which services, timers, shells, or containers are running on a host.

## Shared invariants

- src/embedding-descriptor.ts selects Gemini when SHADOW_EMBEDDING_CURRENT_CONTRACT is absent. With the pinned Qwen contract selected, it selects Qwen unless SHADOW_EMBEDDING_ROLLBACK_WRITES=true.
- src/embedding.ts is the normal profile adapter. Qwen calls pass through local-embedding-runtime.ts and local-embedding-client.ts. Gemini calls first reserve the database rollback budget.
- Migration 039 captures every memory insert and every source/lifecycle-changing update in the writer transaction. Its AFTER UPDATE trigger compares revision, so changes made by the migration 025/027 BEFORE UPDATE revision trigger are observed even if revision was absent from SET. It also captures subscription inserts and query_text/status changes.
- Capture invalidates the old manifest and durably queues a new generation. A writer is eager only when it prepares every Qwen chunk before the transaction and calls a migration 042 publication function inside the parent write transaction.
- Migration 042 publication rechecks authorization, lifecycle, source hash, revision, contiguous chunk coverage, token bounds and normalized vectors under a parent lock. It marks work complete only after the complete manifest becomes current.
- Canonical memories.embedding and memory_subscriptions.query_embedding remain compatibility vectors. Target search and matching use target manifests/chunks and subscription targets.

## Writers

| Writer/path | Profile adapter | Capture and publication | Rollout requirement |
|---|---|---|---|
| Single store: src/tools/store.ts | Normal embedWithProfile; Qwen also calls prepareLocalDocument. | Insert/idempotent upsert is captured. Full Qwen chunks are eagerly published atomically. Contradiction successors also eagerly publish. Dedupe access/tag updates are captured when revision advances. | Restart every HTTP/MCP process. Gemini uses the rollback reservation. |
| Update: src/tools/update.ts and src/memories.ts | Normal embedWithProfile writes compatibility vector plus identity. | Content, tag, metadata, validity and supersession changes are captured. No eager full Qwen publication; durable worker completes it. | Restart HTTP/MCP processes. |
| Document store: src/tools/store-document.ts | Normal embedWithProfile per document chunk. | Document and memory rows commit atomically; inserts are captured. No eager target manifest. | Restart API/MCP processes; expect queue bursts. |
| Watcher: src/watcher.ts and src/watcher/sync.ts | Normal embedWithProfile with identity carried beside each prepared chunk. | Source-key upserts, stale deletes and sync-state commit are atomic. Memory changes are captured; target publication is asynchronous. | Explicitly restart the separate long-lived watcher. Its in-memory path queue is not the durable embedding queue. |
| Transfer import: src/transfer/import.ts | Normal embedBatchWithProfile and exact returned-identity validation. | Accepted imports commit in one scoped transaction and are captured. Historical created_at does not bypass capture. No eager publication. | Restart every process exposing import. |
| Preseed: scripts/preseed-*.ts, scripts/lib/preseed-db.ts and scripts/lib/preseed-embedding.ts | Normal embedBatch and active descriptor. | Inserts/changed upserts are captured; no eager publication. | Run one-shot jobs only from the new release and reviewed environment. Remove stale timer/wrapper references to old checkouts. |
| Archive NULL staging and embedding: src/archive/sync-store.ts and sync-cli.ts | Snapshot copy initially writes NULL identity; embedArchiveBatch later uses normal embedBatchWithProfile. | Initial source/lifecycle writes and later vector update are captured, potentially as separate generations. No eager publication. | Restart/relaunch archive sync and embedding workers; drain target work before completion. |
| Episodes and facts: src/session-distillation.ts | Normal embedWithProfile and active descriptor. | Episode/fact inserts are captured; no eager publication. | Restart API plus any separate distillation runner. |
| Media rollups: src/rollup.ts | Normal embedWithProfile. | Insert is captured; no eager publication. | Restart API and external scheduler invoking rollup. |
| Consolidation: src/consolidation.ts and scripts/consolidate-memories.ts | Qwen prepareLocalDocument; legacy uses normal embedWithProfile. | Canonical insert/member lifecycle changes are captured. New Qwen canonical eagerly publishes atomically. Deconsolidation invalidates through capture. | Relaunch CLI; candidate mutation paths have target-scope completeness guards. |
| Contradiction successor: src/contradictions.ts through store.ts | Reuses the fully prepared store input and active identity. | Predecessor close/successor insert are captured; successor eagerly publishes. Shadow-only classification does not mutate. | Restart API/MCP. Its bounded in-process scheduler is not durable indexing. |
| Reflection: src/reflection.ts and scripts/reflect.ts | Normal embedWithProfile. | Insight inserts are captured; no eager publication. | Relaunch CLI/scheduler. |
| Taste profiles/source-key revisions: src/taste-profile.ts and src/memories.ts | Normal embedWithProfile and active identity. | Content/vector update, predecessor closure and successor insert are captured. No eager publication. | Relaunch CLI/scheduler. |
| Subscriptions: src/subscriptions.ts | Query-role local preparation or normal embedQuery. | Insert and query/status changes are captured. New Qwen subscription target eagerly publishes atomically; subsequent edits rely on worker capture. | Restart API/MCP and webhook-related workers. |
| Legacy re-embed: scripts/reembed-all.ts and scripts/lib/maintenance-embedding.ts | Canonical Gemini maintenance adapter and compatibility-vector update. The adapter reserves legacy rollback inputs before every HTTP request. | Updates are captured and enqueue target repair. Post-cutover calls require environment/database target agreement, explicit rollback-writes consent, and an accepted reservation on the same identity-checked client used for writes. | Launch only with reviewed target/rollback environment. Batch size is capped at 1,000 before inventory or inference; policy denial never falls back per row. |
| Media date repair: scripts/repair-media-rollup-dates.ts | Normal production embedding adapter when content changes. | Update is captured; no eager publication. | Relaunch from new release. |
| Source-key/tag/progress/duplicate/lifecycle repairs: scripts/repair-*.ts | Usually preserve vectors or do not call an embedder. | Content, revision and indexed lifecycle changes are captured. Pure access counters, relevance or source-key-only changes do not need a new target vector. | Execute reviewed row scope from the new release. |

Raw SQL from an external client is covered only when migration 039 and its corrected AFTER UPDATE trigger are installed and capture is enabled. Database owners can disable or bypass controls, so operator SQL remains part of the deployment boundary.

## Consumers

| Consumer | Target behavior and readiness |
|---|---|
| Search: src/search.ts | Uses Qwen query vectors and complete current manifests after target selection. Serving-contract, readiness and integrity checks fail closed. Legacy profile fan-out is compatibility behavior. Restart API/MCP. |
| Store dedupe: store.ts and local-embedding-consumers.ts | Uses maximum target chunk similarity and refuses incomplete or over-broad scope. |
| Consolidation selection: consolidation.ts | Uses the active space and refuses mutation when target coverage is incomplete. |
| Contradiction classification: contradictions.ts and local-embedding-consumers.ts | Uses current complete target manifests and refuses missing/oversized scope. |
| Subscription matching: migrations 041/042 | Matches Qwen subscription targets only against complete current Qwen chunks. Prospective insert events preserve insert-only semantics and wait for target readiness under the migration rules. |
| Evaluation: evaluation.ts, shadow-embedding-quality.ts and eval scripts | Can intentionally compare named spaces. Operator evaluation configuration does not select production serving. |
| Worker/control/index/status | shadow-embedding-worker.ts, shadow-embedding-store.ts and shadow scripts process durable work and enforce manifest/runtime/release gates. Completion does not replace writer restarts. |

Deletion through src/memory-lifecycle.ts and src/tools/forget.ts is also a writer: deleted_at is explicitly compared by the capture trigger, which invalidates current target visibility and queues classification even though deletion does not advance the content revision. Expiry is time-driven; future valid_from and expiry handling therefore also depends on the worker/control inventory and deferred scheduling rather than only mutation events.

## Provider and bypass scan

Static searches for fetch, provider endpoints, embedding assignments, inserts and updates found three embedding network routes:

1. src/embedding.ts: centralized Gemini/Ollama adapter; Gemini is rollback-budgeted.
2. src/local-embedding-client.ts to src/local-embedding-gateway.ts: authenticated Qwen route; only the gateway talks to loopback llama.cpp.
3. scripts/lib/maintenance-embedding.ts: direct Gemini maintenance route used by reembed-all.ts. It explicitly calls reserveLegacyRollbackEmbeddingInputs before fetch and is covered by the shared rollback budget.

Other fetch calls are generation, media connectors, archive retrieval, or import/export transport. No Google embedding SDK import or second direct Gemini embedding writer was found.

## Operator process inventory

The repository does not define the full host process topology. Discover service identifiers rather than inventing them. Before cutover, record every running or scheduled instance that can load this repository or write the relevant tables:

- API HTTP and MCP stdio servers;
- file watchers;
- archive sync and archive embedding workers;
- webhook delivery, distillation, rollup, reflection, taste-profile, consolidation and repair jobs;
- systemd services/timers, cron entries, containers, process managers and persistent shells;
- external applications with direct database write credentials.

For each process, record executable path, checkout/release SHA, start time, environment source, active profile/contract variables and restart/reload mechanism. Stop or restart every stale mutable process before target serving. Several modules resolve environment at initialization; editing an env file or service-manager environment without restarting Node is insufficient. Disable old timers and verify that no old checkout can launch.

After restart, verify the approved release and target runtime receipt for every process, then check durable queue and audit gates. Keep rollback writes disabled unless the serving row explicitly enables the time-bounded database budget.

### Maintenance compatibility boundary

The rollback helper first discovers migration 040 through catalog functions, so a genuinely pre-migration database with no target environment retains historical Gemini behavior without referencing a missing table. Once a serving row exists, that database row is authoritative: missing or stale target environment fails closed. Maintenance binds reservation calls to the exact client that passed the all-row database/server identity preflight. Tests assert reservation-before-fetch, no fetch after denial, same-client binding, the 1,000-input cap, and no per-row fallback for policy denial.
