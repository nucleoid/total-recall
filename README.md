# Total Recall

Universal AI memory system — a single source of truth for every AI tool and agent in your life.

## Vision

Every AI tool you use (OpenClaw, Cursor, Claude, work tools) operates in isolation with no shared memory. Total Recall fixes that: a centralized, vectorized memory store with an MCP interface that any LLM or AI tool can plug into. What you tell one agent, all agents can recall — with proper access controls.

## Database Configuration

Provision and migrate with a schema-owner connection, then run every application process with the scoped app role:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>:<owner-password>@localhost:5432/<database>
APP_DATABASE_PASSWORD='<new-app-password>' npm run provision
MIGRATION_DATABASE_URL=postgresql://<owner-role>:<owner-password>@localhost:5432/<database> npm run migrate
DATABASE_URL=postgresql://total_recall_app:<app-password>@localhost:5432/<database>
```

MIGRATION_DATABASE_URL is required by both owner-only commands; there is no DATABASE_URL fallback. Keep the owner URL and one-shot `APP_DATABASE_PASSWORD` out of runtime/service environments. The MCP server, REST API, importers, watcher, connector syncs, rollup, and other DB-backed processes use only `DATABASE_URL`. Provisioning keeps the fixed `total_recall_app` role required by the migrations, discovers the connected database rather than assuming its name, and preserves an existing password unless `npm run provision -- --rotate-app-password` is explicitly requested.

Recall queries set pgvector's transaction-local HNSW search breadth from `HNSW_EF_SEARCH`. The value must be a decimal integer from `1` to `1000`; when unset, empty, or whitespace-only, Total Recall uses `200`. Invalid non-blank values fail during startup before the MCP server or REST API starts accepting traffic.

### Coordinated database password rotation

Treat the formerly committed application-role password as compromised. Use one controlled, backed-up deployment window:

1. Confirm a verified restorable database backup and inventory every DB-backed process.
2. Prepare the new `DATABASE_URL` secret for every DB-backed process.
3. With owner-only `MIGRATION_DATABASE_URL` and one-shot `APP_DATABASE_PASSWORD`, run `npm run provision -- --rotate-app-password`, then activate the updated service secrets in the same coordinated window.
4. Run `npm run migrate` with `MIGRATION_DATABASE_URL`.
5. Restart every DB-backed process; do not leave any process running with the old password.
6. Verify RLS namespace isolation and application connectivity with the runtime app role.
7. Remove the old secret only after verification. If credential rollback is needed, perform another controlled rotation rather than restoring the compromised password.

This rotation changes only the PostgreSQL app-role password. Total Recall API keys remain unchanged, so it causes no API-key reauthentication or token replacement. Migration 020 grants the RLS-scoped database delete capability used by the memory lifecycle; migration 024 adds tombstones. No memory backfill or reindex is required (`deleted_at IS NULL` means existing rows are active), but migration 024's two `NOT VALID` constraints must be validated and its two partial indexes built with the separate online finalizer described below.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENTS                                │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ OpenClaw │ │ Cursor   │ │ Work AI  │ │ Future   │        │
│  │ (home)   │ │ (dev)    │ │ (HoT)    │ │ Agents   │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │            │            │            │              │
│       └──────┬─────┴─────┬──────┘            │              │
│              │            │                  │              │
│         ┌────┴────┐  ┌────┴──────┐           │              │
│         │  Local  │  │ Cloudflare│◄──────────┘              │
│         │  MCP    │  │  Tunnel   │  (external access)       │
│         └────┬────┘  └────┬──────┘                          │
│              │            │                                 │
│              └──────┬─────┘                                 │
│                     │                                       │
└─────────────────────┼───────────────────────────────────────┘
                      │
        ┌─────────────┴───────────────┐
        │     MCP Memory Server       │
        │     + Express REST API      │
        │                             │
        │  MCP Tools:                 │
        │  • memory_store             │
        │  • memory_store_document    │
        │  • memory_update            │
        │  • memory_search            │
        │  • memory_graph             │
        │  • memory_recall            │
        │  • memory_list              │
        │  • memory_list_namespaces   │
        │  • memory_forget            │
        │  • memory_stats             │
        │  • agent_register           │
        │  • agent_list               │
        │                             │
        │  REST API:                  │
        │  • POST /api/search         │
        │  • POST /api/store          │
        │  • POST /api/store-document │
        │  • DELETE /api/memories     │
        │  • GET  /api/stats          │
        │  • GET  /api/agents         │
        │  • POST /api/agents         │
        │  • GET  /api/traces         │
        │  • GET  /api/audit          │
        │                             │
        │  ┌───────────┐  ┌────────┐  │
        │  │ Auth/ACL  │  │ Embed  │  │
        │  │ Layer     │  │ Model  │  │
        │  └───────────┘  └────────┘  │
        └─────────────┬───────────────┘
                      │
        ┌─────────────┴───────────────┐
        │    PostgreSQL + pgvector    │
        │                             │
        │  ┌─────────────────────┐    │
        │  │ memories            │    │
        │  │ ─────────────────── │    │
        │  │ id          UUID PK │    │
        │  │ content     TEXT    │    │
        │  │ embedding   VECTOR  │    │
        │  │ source      TEXT    │    │
        │  │ namespace   TEXT    │    │
        │  │ tags        TEXT[]  │    │
        │  │ metadata    JSONB   │    │
        │  │ agent_id    UUID FK │    │
        │  │ session_id  TEXT    │    │
        │  │ document_id UUID FK │    │
        │  │ chunk_index INT     │    │
        │  │ source_key  TEXT UQ │    │
        │  │ supersedes_id UUID  │    │
        │  │ superseded_at TS    │    │
        │  │ revision    INT     │    │
        │  │ created_at  TS      │    │
        │  │ updated_at  TS      │    │
        │  │ accessed_at TS      │    │
        │  │ access_count INT    │    │
        │  └─────────────────────┘    │
        │                             │
        │  ┌─────────────────────┐    │
        │  │ agents              │    │
        │  │ ─────────────────── │    │
        │  │ id          UUID PK │    │
        │  │ name        TEXT UQ │    │
        │  │ type        TEXT    │    │
        │  │ model       TEXT    │    │
        │  │ runtime     TEXT    │    │
        │  │ parent_id   UUID FK │    │
        │  │ api_key_id  UUID FK │    │
        │  │ metadata    JSONB   │    │
        │  │ first_seen  TS      │    │
        │  │ last_seen   TS      │    │
        │  └─────────────────────┘    │
        │                             │
        │  ┌─────────────────────┐    │
        │  │ recall_traces       │    │
        │  │ ─────────────────── │    │
        │  │ id          UUID PK │    │
        │  │ session_id  TEXT    │    │
        │  │ agent_id    UUID FK │    │
        │  │ client_id   TEXT    │    │
        │  │ query_text  TEXT    │    │
        │  │ memory_ids  UUID[]  │    │
        │  │ result_count INT    │    │
        │  │ scores      JSONB   │    │
        │  │ duration_ms INT     │    │
        │  │ created_at  TS      │    │
        │  └─────────────────────┘    │
        │                             │
        │  ┌─────────────────────┐    │
        │  │ documents           │    │
        │  │ audit_log           │    │
        │  │ api_keys            │    │
        │  │ sync_state          │    │
        │  └─────────────────────┘    │
        └─────────────────────────────┘
```

## Request limits

All public REST and MCP requests use the same bounded JSON contract:

- encoded JSON body: **8 MiB**; use identity `Content-Encoding` only;
- memory content: **100,000 JavaScript characters** (UTF-16 code units);
- document content: **1048576 UTF-8 bytes**, losslessly chunked to at most 2000 UTF-8 bytes per embedding;
- per-request metadata: **65536 serialized JSON bytes**, maximum **depth 16** and **1000 keys total** across the complete metadata value;
- tags: **100 tags**, each at most **256 JavaScript characters per tag**;
- document titles and other bounded identifier/source fields: 512 JavaScript characters.

Set reverse-proxy body limits to 8 MiB or slightly larger and also enforce appropriate request-rate and concurrency controls. The application returns JSON `400` with `{ "code": "invalid_json" }` for malformed JSON, `400` with `{ "code": "invalid_metadata" }` when memory, document, or agent metadata exceeds its per-request envelope, `413` with `{ "code": "payload_too_large" }` for an oversized encoded body, and `415` with `{ "code": "unsupported_content_encoding" }` for compressed/non-identity requests. Decoded field-limit violations return JSON `400` validation errors. Media-event metadata retains its endpoint-specific compatibility contract rather than inheriting the memory/document/agent envelope. Agent re-registration merges supplied metadata keys into the stored agent record, so the limit applies to each request value rather than the accumulated stored JSON.

## MCP Tools

### `memory_store`
Store a single memory/fact with metadata. Optionally track which agent stored it.
```json
{
  "content": "User prefers Besu+Lodestar for ETH validation (minority clients)",
  "source": "agent-conversation",
  "namespace": "personal",
  "tags": ["ethereum", "staking", "preference"],
  "agent_name": "my-agent",
  "session_id": "conv-123"
}
```

`access_level` defaults to `normal` and may be `normal`, `sensitive`, or `secret`. The caller's API key must have a `max_access_level` at least as high as the memory being stored.

### `memory_update`
Patch an active current memory by UUID. At least one of `content`, `tags`, `metadata`, or `supersedes` is required; omitted fields are unchanged, while supplied tags and metadata replace the complete value (including `[]` and `{}`). Content must be nonblank and is re-embedded only when changed. Provenance, namespace, source, access level, document identity, creation/deletion state, and existing lifecycle links are immutable.

```json
{
  "id": "<new-current-memory-uuid>",
  "content": "User lives in Austin",
  "tags": ["profile", "location"],
  "supersedes": "<old-location-memory-uuid>"
}
```

A supersession atomically closes the predecessor and creates one immutable successor link. Both rows must be active/current, distinct, visible, and in the same namespace. After validity schema deployment, manual `memory_update` uses one database timestamp for the predecessor's `valid_to`/`superseded_at` and the successor's `valid_from`, producing contiguous half-open intervals; linking an already stored successor establishes its temporal validity at that boundary rather than its original store time. Before migration 026, the writer probes the schema and uses the #52 shape without validity columns; a partial validity schema fails closed and unrelated SQL errors are never treated as compatibility fallback. Historical rows remain available through list and direct recall with `supersedes_id`, `superseded_by_id`, `superseded_at`, `is_superseded`, and `revision`, but a linked UUID is returned only when that linked row is itself active, in the requested namespace, and visible at the caller's access-level ceiling. When the separately reviewed `SUPERSEDED_SEARCH_DEMOTION_ENABLED=true` gate is enabled, ordinary search demotes history by `SUPERSEDED_SCORE_FACTOR` (default `0.25`) before final ordering and limiting. Forgetting or purging a successor never reopens its predecessor; the predecessor marker is durable, and its purge is blocked while a successor still references it.

### `memory_store_document`
Chunk and store a full document. Content must contain non-whitespace text and is limited to **1 MiB of decoded UTF-8**. Chunking prefers markdown headings and paragraph boundaries, then splits on Unicode code-point boundaries so every embedding chunk is at most **2,000 UTF-8 bytes** without dropping or changing source text. Chunks share a `document_id` for full-document retrieval.
```json
{
  "title": "NZ Tax Residency Rules",
  "content": "<full document text>",
  "namespace": "personal",
  "tags": ["tax", "nz", "immigration"],
  "source": "manual"
}
```
Document chunks are stored with `normal` access unless document classification is added in a later schema/API change. The decoded limit is enforced consistently by the MCP and REST schemas (400 for invalid decoded content). HTTP JSON envelope limits are independent and can reject a request earlier with 413; this change does not raise the server's transport parser limit. Reusing an idempotency key after any visible chunk of that document has been forgotten returns HTTP 409 with `idempotency_key_tombstoned`; it never restores or replaces the forgotten chunks. Documents and chunks outside the caller's namespace grants remain undisclosed.

### `memory_search`
Hybrid semantic + keyword search with filters. Every search is logged as a recall trace with timing data.
```json
{
  "query": "what validator clients are preferred",
  "namespaces": ["personal"],
  "limit": 5,
  "threshold": 0.3,
  "agent_name": "cursor",
  "session_id": "dev-session-42"
}
```

After memory-validity finalization, pass an offset-aware ISO-8601 `valid_at` to search the half-open interval `valid_from <= valid_at < valid_to` (or an open-ended interval). Historical search does not apply today's supersession demotion. Results, direct recall, and list output include `memory_kind`, `valid_from`, `valid_to`, and supersession fields.

### `memory_graph`
Traverse exact normalized entity names and their co-occurring `person`, `project`, `tool`, and `place` entities. The optional namespace list is intersected with the caller ACL and `depth` is bounded from 0 to 3. Responses are versioned and capped at 100 entities, 500 active memories, and 1,000 edges, with explicit indexing-completeness and truncation flags.

Entity extraction is eventually consistent and disabled until a separate #55 provider/model, terms, one-namespace `normal` scope, and cost policy is approved. See [`docs/entity-graph-rollout-runbook.md`](docs/entity-graph-rollout-runbook.md).

### `memory_recall`
Get a specific memory by ID, or all chunks of a document by `document_id`.

### `memory_list`
Browse/paginate memories with optional filters (no vector search).

### `memory_list_namespaces`
List available namespaces and their memory counts.

### `memory_forget`
Soft-delete memories by `ids`, `namespace`, strict `before` (`created_at < before`), and/or `tags` (AND containment). Selectors combine with AND. At least one selector is required; every request without `ids` must include `"confirm": true`. A request is capped at 100 IDs and 100 authorized matches. The API key needs the explicit `delete` permission—`write` does not imply deletion. Results contain only newly tombstoned authorized IDs; missing and inaccessible IDs look identical.

Tombstones disappear from all ordinary recall, search, list, count, access-boost, and maintenance operations. Document chunks can be forgotten independently; the original document ingestion count is immutable, and document recall reports not-found once no active chunks remain. A `source_key` retry cannot restore a tombstone. Deletion reasons are bounded and stored on the tombstone but are never copied to audit/log output.

### `memory_stats`
Admin-only statistics: total memories, breakdown by namespace and source, document count, date range.

### `agent_register`
Register or update an AI agent in the provenance system.
```json
{
  "name": "cursor-dev",
  "type": "llm",
  "model": "claude-sonnet-4-6",
  "runtime": "cursor",
  "parent_agent_name": "openclaw"
}
```

### `agent_list`
List registered agents owned by the authenticated API key, with memory counts and last activity. Requires `read` permission.

## Agent Provenance Model

Every memory can be linked to the agent that created it. Agents are identified by name and auto-registered on first interaction.

**Agent fields:**
- `name` — unique identifier (e.g., "openclaw", "cursor-dev", "claude-work")
- `type` — `llm`, `system`, `human`, or `tool`
- `model` — the LLM model used (e.g., "claude-opus-4-6")
- `runtime` — the tool/platform running the agent (e.g., "openclaw", "cursor", "claude-code")
- `parent_agent_id` — for spawned sub-agents, links to the parent

**How it works:**
1. When `memory_store` or `memory_search` is called with `agent_name`, the agent is resolved (created if new, updated if existing)
2. The `agent_id` is stored on the memory record for provenance
3. Use `agent_list` with a `read` API key to see that key's registered agents and memory counts

## Recall Trace Auditing

Every search operation is automatically logged as a recall trace, enabling full audit of how memories are accessed.

**Trace fields:**
- `query_text` — what was searched
- `agent_id` — which agent performed the search
- `session_id` — groups traces within a conversation/session
- `memory_ids` — which memories were returned
- `scores` — per-result scoring breakdown (vector, text, final)
- `duration_ms` — how long the search took

**REST API for traces:**
```
GET /api/traces?limit=20&offset=0&agent_id=<uuid>&session_id=<string>
```

Agent and trace listing endpoints are scoped to the authenticated API key at the database layer. The REST observability endpoints additionally require the explicit `admin` permission so ordinary keys cannot enumerate administrative data.

## REST API

All `/api/*` endpoints require `Authorization: Bearer tr_<key>`. `/health` is public. Global observability and media-administration routes require the explicit `admin` permission; `admin` is never granted implicitly.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/search` | Hybrid semantic + keyword search |
| POST | `/api/store` | Store a single memory |
| POST | `/api/store-document` | Store a chunked document |
| DELETE | `/api/memories` | Soft-delete matching memories (explicit `delete` permission) |
| GET | `/api/stats` | Memory statistics (admin) |
| GET | `/api/agents` | List registered agents and counts (`admin` + `read`) |
| POST | `/api/agents` | Register/update an agent (`admin` + `write`) |
| GET | `/api/traces` | Paginated recall traces (`admin` + `read`) |
| GET | `/api/audit` | Paginated audit log (`admin` + `read`) |
| POST | `/api/media/search` | Vector search over authorized media history (`read`) |
| POST | `/api/media/events` | Upsert media events (`admin` + `write`) |
| GET | `/api/media/events` | List structured media events (`admin` + `read`) |
| POST | `/api/media/rollup` | Trigger pending events → summary memories (`admin` + `write`) |

`openapi.yaml` is the Custom GPT action contract. Run `npm run test:contract` after changing REST registration, request schemas, or response shapes; the contract suite validates OpenAPI 3.1 and enforces exact method/path parity with runtime registration. See [the admin rollout runbook](docs/rollouts/050-openapi-admin.md) before deploying the tightened administrative routes.

### Tombstone purge operations

Hard purge is manual, preview-first, and fixed at a 30-day retention window. Configure an owner/BYPASSRLS maintenance URL and an explicit complete namespace inventory; no automatic purge schedule is shipped:

```bash
PURGE_NAMESPACES='["shared","work"]' MAINTENANCE_DATABASE_URL='postgresql://...' \
  npm run purge:deleted -- --preview purge-preview.json
# Independently review and preserve the preview, then:
PURGE_NAMESPACES='["shared","work"]' MAINTENANCE_DATABASE_URL='postgresql://...' \
  npm run purge:deleted -- --apply purge-preview.json
```

Each preview captures at most 10,000 rows in deterministic retention order; apply that page and generate a new preview file until no candidates remain. Apply rejects missing/stale previews, candidate drift, an empty or incomplete namespace inventory, and concurrent runs. It commits deterministic bounded batches and writes one content-free `memory.purge` audit row before each hard delete in the same transaction. Tombstones referenced by media events are reported and retained, preventing an `ON DELETE SET NULL` link from making forgotten rollups eligible for re-ingestion. A blocked or partial run exits nonzero. Before apply, stop relevant writers, verify a restorable backup, and review the opaque IDs/fingerprints. Before 30 days, recovery requires a separate explicit audited restoration procedure; after purge, recovery is backup-only. For any incident or rollback, disable `memory_forget`/REST deletion and `purge:deleted` first. Never roll back to a binary that ignores `deleted_at`.

### Media summary calendar time zone

Media summary dates use the optional `MEDIA_TIME_ZONE` IANA time zone (for example, `America/Chicago`). When unset or blank it defaults explicitly to `UTC`; the host locale and `TZ` do not change rollup output. Configure the same value on every HTTP and scheduled rollup worker and restart them. Structured `played_at` timestamps and rollup metadata remain UTC instants.

Existing summaries are not changed automatically. Preview the resumable, tuple-checkpointed repair before applying it:

```bash
npm run media:repair-dates
npm run media:repair-dates -- --apply --batch-size 100
# Resume using the checkpoint printed by the prior run:
npm run media:repair-dates -- --apply --after-played-at <ISO_TIMESTAMP> --after-id <EVENT_UUID>
```

Dry-run is the default and performs no embedding or writes. Applying consumes embedding quota and atomically refreshes summary text, vector, tags, and metadata only when the linked event and media memory still match. Back up/review first, stop overlapping rollup or repair workers, and use optional `--service`, `--played-after`, and `--played-before` filters as needed. A provider or row failure aborts immediately, reports one bounded error without summary content, leaves the checkpoint before that row for a retry, and makes the command exit nonzero. A concurrent change likewise stops the scan with the checkpoint before that row; resume from that checkpoint after quiescing overlapping workers. If `skippedConcurrent` is greater than zero, always finish with a final no-cursor reconciliation pass (omit both `--after-*` options) so no concurrently skipped row is permanently passed.

## Data Sources & Sync Model

### Automatic (MCP — ongoing)
Once connected, every LLM tool stores memories through MCP in real-time. No sync needed.

### File Sync (watcher/cron — ongoing)
Key files are monitored for changes, diffed by content hash, chunked, and upserted.

**Watched files:**
- `MEMORY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` → `personal` / `projects`
- `memory/*.md` (daily logs) → `personal` + `projects`
- Cortex content: `journals/`, `concepts/`, `projects/`, `documents/` → mixed namespaces

**Workspace setup:**
- Set `OPENCLAW_WORKSPACE` to an existing workspace directory (for example, `C:\Users\me\.openclaw\workspace` on Windows). Relative values resolve from the watcher process's working directory.
- If the variable is absent, the watcher retains the Linux compatibility default `/home/fuego/.openclaw/workspace`; a blank value or missing/non-directory root fails startup. Optional files and child directories may be absent.
- Restart the watcher after changing the root. A root change does not authorize historical deletion: audit and back up existing `file-sync` rows, then stop duplicate watcher instances before changing an established root.

**Exclusions:**
- The watcher skips non-`.md` files (the extension check is case-sensitive), `.env*` basenames, files larger than 1,000,000 bytes, and paths containing an exact case-insensitive `deliverables` directory segment. Lookalikes such as `my-deliverables/` and `DELIVERABLE-notes.md` are not excluded.
- Body text is not an exclusion signal: `DELIVERABLE` in prose, frontmatter, headings, fenced code, or quoted text is synced normally.
- Policy skips log only the canonical workspace-relative path and a stable reason code. Unchanged files remain silent; filesystem races and processing errors are handled separately.

**Sync mechanics:**
- `sync_state` tracks `file_path → watcher:v2:<content hash>` using `/`-separated, workspace-relative identities on every OS. The same portable identity is used for metadata and source keys.
- Duplicate headings use their one-based occurrence among identical, trimmed structured heading paths. The first occurrence retains its legacy source key; later H2 or H3 occurrences use a length-prefixed tuple digest named `file-sync:v2:<sha256>`. Chunk metadata records `h2_occurrence` and, for H3 chunks, `h3_occurrence`. Occurrences are positional and include syntactic sections whose bodies are later filtered, so inserting, deleting, or reordering duplicates deterministically updates the corresponding rows.
- Native absolute paths are used only for filesystem access and Chokidar.
- A successful read/parse is a complete desired set. The watcher prepares embeddings first, then atomically upserts current chunks, deletes stale rows owned by `client_id='file-sync'` for that exact path, and advances the fingerprint. A valid empty/frontmatter-only/too-short file therefore removes its old watcher chunks without embedding.
- Directly observed deletion is serialized with add/change work and atomically removes only exact-path `file-sync` rows and matching sync state. Manual/preseed rows are not watcher-owned and survive.
- Symlinks are followed. Containment is lexical rather than a security boundary: a symlink below the workspace may point outside it.
- Read, embedding, SQL, or transaction failure leaves the preceding complete snapshot unchanged. Files deleted before deployment emit no event and are never inferred safe to delete by startup scanning.

**One-time historical orphan repair (explicit operator approval only):**

Deploy migration 020 (#49 DELETE authority) before the corrected watcher; because every reconciliation now includes a scoped stale-row DELETE, deploying the watcher first makes all file sync fail closed until migration 020 is applied. Enforce migrate-before-watcher-restart ordering. Stop every old watcher process during cutover, deploy the transaction/queue foundations and watcher together, then start one watcher. Its first scan upgrades present files to v2 fingerprints, repairs formerly collapsed duplicate-heading rows, and ingests or repairs ordinary files that an older watcher suppressed because their body contained `DELIVERABLE`; this may consume embedding-provider quota and increase memory counts. Move intentionally suppressed files under an exact `deliverables` directory before restart. It does **not** sweep absent paths. A rollback to the old chunker does not understand `file-sync:v2:` duplicate keys and can leave those rows stale; prefer rolling forward, or use the corrected reconciliation to remove them before reverting.

For possible pre-deployment orphans, first take and verify a **verified restorable backup**. Verify that `OPENCLAW_WORKSPACE` is the authoritative, correctly mounted/configured workspace, then produce a content-free bounded preview with an owner/BYPASSRLS maintenance connection:

```bash
MAINTENANCE_DATABASE_URL=postgresql://<owner-role>@<host>/<database> \
  npm run repair:watcher-orphans -- --workspace /authoritative/workspace --preview watcher-orphans.json
```

Preview writes nothing. Independently confirm every candidate against the authoritative workspace; absence alone, a changed exclude, an unmounted root, or path/case uncertainty is not proof. Approval must name exact row IDs and paths. Create a version-1 manifest with `backupVerified: true`, `workspaceVerified: true`, the exact preview `workspaceRoot`, and one approval per confirmed path containing its exact `memoryIds`, `rowFingerprint`, and `syncStateHash`. Counts, paths without IDs, wildcard policy, and approval of the command are not row approval. Apply only that manifest:

```bash
MAINTENANCE_DATABASE_URL=postgresql://<owner-role>@<host>/<database> \
  npm run repair:watcher-orphans -- --workspace /authoritative/workspace --apply approved-watcher-orphans.json
```

Apply locks and rechecks every approved row/path and current fingerprint in one transaction. Present files, drift, unapproved rows, missing backup/workspace acknowledgement, or broad/path-only inference abort without deletion. It deletes only approved exact IDs still owned by `client_id='file-sync'` at the exact path plus matching sync state. Manual/preseed, present, uncertain, and unapproved rows remain unchanged. This repair is never invoked at boot, watcher startup, migration, or package installation.

#### Linux watcher ownership and scheduled diagnostics

Use **systemd as the sole watcher owner** where available. Configure the service with the deployment's absolute Node binary and project directory, run `npm run build`, and start `node dist/watcher.js` from that directory. Do not also install a cron watcher starter. `scripts/daily-sync.sh` is a Linux-only (`bash`, `flock`, and `/proc`) **cron fallback** for deployments without a service manager; it is not the Windows watcher procedure from #31 and does not support macOS.

For the cron fallback, copy `scripts/daily-sync.env.example` to an owner-only deployment file and replace its example paths. `NODE_BIN` must be an absolute executable. `PROJECT_DIR` defaults to the real directory containing this checkout but may be set explicitly. Optional statistics run only when absolute executable `MCPORTER_BIN` and `PYTHON3_BIN` values are supplied. The script intentionally does not source the application's `.env`; source only the dedicated, shell-safe scheduler file from the cron command. **When upgrading from the old script, replace the old bare cron invocation in the same deployment window:** it has no `NODE_BIN`, so the corrected script intentionally rejects it rather than trusting cron's `PATH`.

```cron
*/5 * * * * . /etc/total-recall/daily-sync.env && /srv/total-recall/scripts/daily-sync.sh
```

The fallback serializes startup with a bounded lock wait (`LOCK_TIMEOUT_SECONDS`, default 10) and records its validated watcher under the current user's private `XDG_RUNTIME_DIR/total-recall`, or `/tmp/total-recall-$UID` when no runtime directory is configured. Logs stay there as `watcher.log`; upgrade any tailing or rotation rules that still read the legacy `/tmp/total-recall-watcher.log`. It adopts exactly one same-user watcher launched as either the absolute entrypoint or the legacy `node dist/watcher.js` from this project. If diagnostics report multiple matching watchers, inspect `ps -o pid,user,lstart,args -p <pid,...>`, choose which deployment-owned process to retain, and stop surplus processes manually; the script never guesses or kills a PID. Then rerun it to adopt the survivor. Never run systemd and cron as competing owners.

For upgrades, stop the selected owner, build `dist/watcher.js`, update deployment-specific absolute paths (including NVM's versioned Node path), and restart that same owner. A healthy watcher using an older Node executable can be adopted with a warning, but binary upgrades should use a coordinated restart so the pidfile reflects the intended process. Rollback may remove the private runtime pid/lock files after stopping the fallback watcher; the old script ignores these files and can resume spawning duplicates, so restoring it is not a safe ownership strategy. No schema migration, reindex, API-key/session change, or application downtime is otherwise required.

### Pre-Seed (one-time bulk import)
Bootstrap from existing AI conversation history across platforms.

| Source | Script | Format | Status |
|--------|--------|--------|--------|
| OpenClaw | `preseed-openclaw.ts` | Markdown files | Active after migration 023 |
| ChatGPT | `preseed-chatgpt.ts` | JSON export | Active after migration 023 |
| Claude | `preseed-claude.ts` | JSON export | Active after migration 023 |
| Gemini | `preseed-gemini.ts` | HTML export | Active after migration 023 |

The #41 fail-closed call sites now resolve to #9's canonical descriptor and atomic writer. Apply
`023_embedding_identity.sql` and deploy identity-aware readers before running preseed; an older
schema rejects the descriptor columns instead of accepting unlabelled vectors. Every import embeds
the exact persisted content, validates the complete batch, and writes vector plus descriptor in one
statement.

Claude and OpenClaw preseed require the least-privileged app-role `DATABASE_URL`; never provide `MIGRATION_DATABASE_URL`, a superuser, a `BYPASSRLS` role, or the owner of `memories`. Both commands verify the connected role before reading sensitive source files. Each group contains at most ten fully embedded rows; only then does it begin a transaction, set the exact JSON `app.allowed_namespaces` subset transaction-locally, upsert, and commit. Provider work never holds a database transaction, failures roll back the current group, and no namespace context survives client reuse. This changes only operator command credentials: API keys, sessions, and user reauthentication are unaffected.

Claude requires `CLAUDE_IMPORTS_DIR` (or one directory argument) containing required `conversations.json` and `memories.json`. Empty Claude arrays, absent or empty `chat_messages`, and absent or blank `conversations_memory` produce an explicit zero-write successful summary. Missing files, malformed JSON/shapes, and invalid importable timestamps fail nonzero. Memory content without a valid conversation date uses `--memory-timestamp <ISO timestamp>` when supplied; this explicit operator value takes precedence over the once-captured `memories.json` mtime, which is the fallback when the option is absent.

OpenClaw requires `OPENCLAW_WORKSPACE` (or one directory argument). `OPENCLAW_CORTEX_CONTENT` and `OPENCLAW_SECOND_BRAIN` optionally override their defaults beneath the workspace. Discovered files are canonicalized and deduplicated before batching, including alternate paths.

After migration 023 and the identity-aware runtime are deployed, ChatGPT import requires `CHATGPT_IMPORTS_DIR` or a directory as the first CLI argument. The directory scanner accepts only `conversations.json` and `conversations-<digits>.json` (unsuffixed first, then numeric suffix order); backups and unrelated files are ignored. Each root array is streamed one conversation at a time, output chunks are committed in batches of at most ten, and reruns converge through stable source keys. A failed later file or batch leaves earlier batches committed. The default single-conversation limit is 16 MiB; `--max-conversation-bytes <bytes>` permits an explicit positive override up to 64 MiB, with correspondingly higher Node heap risk.

#### Gemini Takeout identity and historical repair

After migration 023 and identity-aware readers are deployed, set `GEMINI_TAKEOUT_HTML_PATH` (or pass one HTML path) and run `npm run preseed:gemini`. The importer preserves the existing `Q: …\n\nA: …` format and 4,000-character cap, then assigns `gemini-conv:v2:<sha256>` from the exact persisted content and normalized UTC instant. Export reorder or prepend therefore cannot renumber existing conversations. Prompt/response differences beyond 4,000 characters are indistinguishable and cannot be recovered from historical rows.

Timestamp parsing is deliberately explicit and host-timezone independent. Supported named forms are NZST and NZDT, followed by UTC/GMT/Z and numeric offsets such as `+05:30`, `-0330`, `UTC+12:45`, or `GMT-03:30`. English abbreviated month names and 12-hour clocks are required. Unknown/ambiguous abbreviations and localized month names are reported as omissions and make a non-empty partial import exit nonzero; they are never passed to host-local `Date` parsing.

The repair command is **preview-only by default** and requires owner-only `MIGRATION_DATABASE_URL`; it never falls back to the app-role `DATABASE_URL`:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>/total_recall npm run repair:gemini-source-keys
```

Preview scans only positional keys belonging to `client_id='preseed-gemini'` and `source='gemini-conversation'`. It prints bounded IDs, current-state fingerprints, proposed targets, and collision equivalence—not memory content or credentials—and writes nothing. There is no automatic historical cleanup. Before apply: stop Gemini import, take and verify a restorable backup, independently verify every candidate and collision against the original export, and prepare an approval manifest with `version: 1`, `backupVerified: true`, plus an `approvals` entry for every exact affected row. Each entry names `id`, `expectedFingerprint`, `targetKey`, and `action` (`rekey`; byte-equivalent-collision `retain`/`delete` with the exact `retainId`; or `leave` for every row in a non-equivalent collision). Counts, predicates, generated targets, and policy-wide approval are not row approval.

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>/total_recall npm run repair:gemini-source-keys -- --apply ./approved-gemini-rows.json
```

Apply takes an advisory lock and rechecks every row in one transaction. Drift, missing or broad approval, unrelated rows, uniqueness conflicts, non-oldest retention, or deletion of non-byte-equivalent rows rolls the entire operation back. For an approved byte-equivalent collision, retain exactly the oldest ID identified by preview, delete only explicitly named duplicates, and merge no mutable metadata. Deleting a duplicate can leave historical, non-FK audit/trace references pointing at that deleted duplicate ID; independent verification must include those references, and the retained byte-equivalent memory does not rewrite them. Non-equivalent or uncertain collision groups require exact `leave` approvals and remain wholly unchanged. Ordinary approved rows are rekeyed in place, preserving IDs, content, embeddings, metadata, and references; no re-embedding, schema migration, or reindex is performed.

### Ingestion Pipeline (shared by all sources)

```
Source Export (JSON/MD/HTML)
    ↓
Parser (per-source adapter)
    ↓
Chunker (heading-based for MD, turn-pair for conversations)
    ↓
Density Filter (skip low-information exchanges)
    ↓
Deduplicator (skip if >0.92 cosine similarity to existing)
    ↓
Namespace Tagger (auto-classify or rule-based)
    ↓
Canonical embedder (explicit Gemini gemini-embedding-2-preview, 768d)
    ↓
PostgreSQL + pgvector (upsert)
```

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Database | PostgreSQL 16 + pgvector | Battle-tested, vector search built-in, HNSW indexes |
| Embedding target | Gemini `gemini-embedding-2-preview` (768d) | One explicit descriptor for all readers and writers; no implicit fallback |
| Protocol | MCP (Model Context Protocol) | Standard for LLM tool integration |
| REST API | Express 5 | For non-MCP consumers (Cortex dashboard, Custom GPTs) |
| Auth | API keys + namespace ACLs + RLS | Per-client scoping with row-level security |
| External Access | Cloudflare Tunnel | No open ports, TLS, access policies |
| File Watcher | chokidar (Node.js) | Efficient inotify-based, handles nested dirs |
| Deployment | systemd (user services) | Simple, reliable, auto-restart |

## Database Migrations

Run all schema setup through the numbered SQL migrations:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/<database> npm run migrate
```

`MIGRATION_DATABASE_URL` is mandatory and must use a database owner or migration role that can grant privileges, alter tables, create functions, and manage indexes. `DATABASE_URL` is runtime-only and is never a migration fallback. Provision `total_recall_app` before the first migration with `npm run provision`; the runtime role is intentionally narrower and must not receive DDL, superuser, ownership, or `BYPASSRLS` capability.

After acquiring the advisory lock, but before reading or upgrading the migration ledger, the runner performs a read-only authority preflight. It reports only safe `current_user` and `current_database()` identity, never credentials or the connection URL. A non-superuser must have `CREATE` on schema `public` and own existing migration-managed tables, directly or through role membership. Failure stops before ledger or pending migration DDL and directs the operator to use the owner connection; the runner never grants privileges, changes roles, or provisions itself.

The removed standalone decay migrator is not a compatibility path: all decay schema changes come from the immutable numbered migrations. `npm run decay:update` is separate all-row maintenance and requires an operator-only owner or `BYPASSRLS` connection that passes its maintenance preflight; it is not ordinary runtime app-role DML.

Migration files are immutable after distribution. The runner records the SHA-256 of each file's exact bytes and stops before pending migrations if applied history is changed, missing, renamed, malformed, or ambiguous. On the first checksum-aware run, legacy ledger rows are baselined atomically from the reviewed checkout. This trust boundary cannot detect edits made before that baseline, so run it only from a reconciled, immutable release. The sole reviewed compatibility exception is the exact pre-#49 checksum of migration 003: the runner records its sanitized checkout checksum under the advisory lock, while migration 020 carries the DELETE grant/policy forward for databases where 003 was already applied. No other checksum drift is accepted.

Migration runners serialize on a database-local advisory lock before reading or upgrading the ledger and hold it through the last migration. `MIGRATION_LOCK_TIMEOUT_MS` controls the bounded wait (default `30000`, accepted range `1`–`600000` milliseconds). A timeout makes no ledger or schema changes; increase it only when the expected migration duration justifies a longer deployment wait.

A checksum mismatch is an operational stop, not a prompt to overwrite the ledger. Restore the exact migration file from the reviewed release, inspect the ledger and actual schema, then make any required change through an audited forward repair migration. Connection loss can make commit acknowledgement ambiguous, so inspect both schema and ledger before retrying. Rolling back to the old runner ignores checksums and removes drift and concurrency protection; leave the additive `checksum` column in place and restore the checksum-aware runner instead.

### Belief validity and contradiction rollout

Migration 026 adds explicit memory kinds and nullable half-open validity intervals. It must follow #52 migration 025; do not renumber, combine, or apply these releases out of order. Roll it out in stages:

1. Apply #52 migration 025, run `npm run finalize:memory-supersession`, and deploy its supersession-aware readers/writers before any #53 schema or runtime.
2. Apply migration 026 with contradiction classification, automatic mutation, and `SUPERSEDED_SEARCH_DEMOTION_ENABLED` all false. The transaction-wrapped migration does not build the unique supersession index and does not add checks that would reject updates to unbackfilled rows.
3. Deploy all kind/validity-aware writers, still with classification disabled. Writer fallbacks are limited compatibility for migration-by-migration tests; production remains migrate-first.
4. Run bounded, resumable batches with `MIGRATION_DATABASE_URL=... npm run backfill:memory-validity`. Standalone rows start at `created_at`; linked successors start exactly at their predecessor's durable `superseded_at`, repairing links created by the pre-026 writer into contiguous intervals. The backfill does not guess kinds or dates and fails if a linked predecessor boundary is missing.
5. When it reports `pending=0`, run `MIGRATION_DATABASE_URL=... npm run finalize:memory-validity`. The owner-run finalizer rejects duplicate predecessor links and any non-contiguous linked boundary, verifies or idempotently creates migration 025's canonical non-partial `memories_supersedes_id_unique` with `CREATE UNIQUE INDEX CONCURRENTLY`, adds and validates the deferred checks, sets `valid_from NOT NULL`, and builds candidate/temporal indexes concurrently. An invalid interrupted index is dropped concurrently and rebuilt on retry; it does not create a second uniqueness index.
6. Deploy/enable `valid_at` readers. Ordinary search probes the catalog and safely uses its older query shape before migration 026; `valid_at` still fails closed until finalization. Only the fully finalized capability set is cached, for at most `SEARCH_SCHEMA_CAPABILITY_TTL_MS` (default 30 seconds) and only for the current process database-pool generation. Partial/negative states are never cached, pool replacement and the explicit invalidation hook clear assumptions, and every `valid_at` request refreshes its finalization proof. Query-shape selection never catches or hides SQL, permission, timeout, or connection failures.
7. Enable `SUPERSEDED_SEARCH_DEMOTION_ENABLED=true` only as a separately reviewed, reversible ranking rollout. Its restrictive default is false; `SUPERSEDED_SCORE_FACTOR` has no effect while the gate is off.
8. Record every independent #53 approval in `.env`: exact gateway provider/model, privacy/retention/training terms, exactly one low-sensitivity namespace (initially `normal` access only), the process-lifetime reservation cap, reviewed conservative request/input/output price bounds, and shadow concurrency/queue limits. Then enable shadow classification only. Follow [`docs/contradiction-rollout-runbook.md`](docs/contradiction-rollout-runbook.md); `CONTRADICTION_COST_BUDGET_USD` is not represented as exact provider spend.
9. Review bounded content-free outcome metrics, including `budget_exhausted`, `shadow_saturated`, and `shadow_shutdown`. Automatic mutation remains off until `CONTRADICTION_AUTO_MUTATION_ENABLED`, mutation approval, reviewed-metrics approval, and the exact deployment/mutation environment all match.

The generation gateway contract is `POST {model, system, input, max_output_bytes, tools: []}` returning exactly `{output: string}`; it exposes no authoritative billing amount. Consequently, the runtime enforces a deliberately conservative **process-lifetime reservation budget**, not exact provider billing. Before provider egress it reserves `CONTRADICTION_ESTIMATED_REQUEST_COST_USD` plus actual bounded input bytes priced at `CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES` plus the full 1 KiB output allowance priced at `CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES`. Reservations use integer micro-USD, are atomic within this single process, and are never refunded after timeout, provider failure, or ambiguous completion. The first approved runtime configuration is immutable for the process lifetime; any in-process cap, pricing, provider/model, namespace, or scheduler drift fails closed with `runtime_config_changed` rather than opening another accounting partition. Exhaustion skips egress and stores normally. The counter resets on process restart, so operators requiring a durable cross-restart or multi-replica billing ceiling must enforce that at the approved gateway; do not describe this local cap as such a ceiling.

No embedding key, provider setting, or approval for another generative feature enables #53. Idempotent stores never query candidates or call the generation gateway. Shadow-only classification starts after the normal unkeyed store commits, is best-effort, and adds no provider wait to the store response. The process admits at most `CONTRADICTION_SHADOW_MAX_IN_FLIGHT` active shadows (default 2) and retains at most `CONTRADICTION_SHADOW_MAX_QUEUED` queued shadows (default 8); saturated work is skipped with a content-free reason, and shutdown rejects new work, drops queued work, then drains only active calls. Each admitted request can send the new memory plus at most five candidate excerpts, bounded to 64 KiB total input, and can receive at most 1 KiB classifier output (plus a 1 KiB JSON-envelope allowance). Candidate SQL receives a local statement timeout, and the provider receives only the remaining portion of the single `CONTRADICTION_TIMEOUT_MS` classification deadline (default 10 seconds, maximum 60 seconds). Mutation-enabled unkeyed stores must wait for that bounded classification because only its result can drive the atomic successor transaction. Provider failures, malformed/oversized output, low confidence, stale candidates, budget exhaustion, saturation, and review-only results preserve normal unlinked storage. Metrics/logs contain only fixed outcome codes, never prompts, candidate IDs, memory IDs, namespaces, provider bodies, SQL, or API keys.

Rollback order is strict: disable automatic mutation first, wait for in-flight mutation-capable requests to drain, disable classification, reject new/drop queued shadows and wait up to the configured timeout for active shadow calls, then disable superseded-row demotion. Never reopen a closed interval automatically. Keep migration 025/026 columns, checks, links, and indexes. The current search reader can roll back across migration 026 for ordinary searches, but `valid_at` must be disabled first; after any supersession link exists, never deploy a pre-#52 reader or writer.

Before deploying migration 007 to an existing database, check who owns the legacy decay function. Function signature: `public.calculate_relevance(double precision, double precision, timestamp with time zone, integer)`.

```sql
SELECT pg_get_userbyid(p.proowner) AS function_owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'calculate_relevance'
  AND pg_get_function_identity_arguments(p.oid) =
    'p_relevance_score double precision, p_decay_rate double precision, p_accessed_at timestamp with time zone, p_access_count integer';
```

If this returns no row, or the owner is already the migration owner, run `npm run migrate` with the owner migration connection above. If it returns `total_recall_app`, perform one owner-approved DBA remediation before migration 007:

```sql
-- Preferred when keeping the function available until migration 007 runs:
ALTER FUNCTION public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER) OWNER TO <migration-owner>;

-- Alternative when a short maintenance window can tolerate recreating it in migration 007:
DROP FUNCTION IF EXISTS public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER);
```

Run the remediation as a database owner or equivalent DBA role. Do not grant `total_recall_app` general DDL privileges, and do not elevate the runtime app role for this migration.

Before deploying migration 019, repeat the ownership check for its exact canonical signature. Migration 019 changes only function volatility metadata, so the role running `npm run migrate` must own the function even when that role is otherwise DDL-capable:

```sql
SELECT pg_get_userbyid(p.proowner) AS function_owner
FROM pg_proc p
WHERE p.oid = to_regprocedure(
  'public.calculate_relevance(double precision,double precision,timestamp with time zone,integer)'
);
```

If the returned owner differs from the migration role, have the function owner or a superuser transfer ownership before running migration 019:

```sql
ALTER FUNCTION public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER) OWNER TO <migration-owner>;
```

Alternatively, the function owner or a superuser may drop and recreate the canonical function from migration 018 with `<migration-owner>` as owner before retrying. Do not merely drop it: migration 019 intentionally does not recreate or replace the function body. The migration fails before changing volatility with SQLSTATE `42501` and this remediation when ownership has drifted. Do not grant `total_recall_app` general DDL privileges or otherwise elevate the runtime role.

Migration 007 intentionally does not backfill existing `last_boosted_at` values inside the schema transaction. To repair legacy rows after the migration is applied, run the bounded operational repair with the same owner or migration connection:

```bash
DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run repair:last-boosted-at -- --dry-run
DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run repair:last-boosted-at -- --batch-size 1000 --max-rows 10000
```

The repair is resumable: re-run it until `remainingRows` is `0`. It updates only rows where `last_boosted_at IS NULL`, setting the value to `COALESCE(accessed_at, created_at, NOW())`, and preserves existing non-null values by default. Do not overwrite non-null `last_boosted_at` values without a separate reviewed dry run and repair plan.

Migration 015 adds nullable `memories.event_at` for media played-time filtering. It intentionally does not backfill historical rows or build the search index inside the normal transaction-wrapped migration runner. The historical repair accepts offset-aware ISO timestamps and uses PostgreSQL 16 `pg_input_is_valid` to report malformed timestamp strings without aborting the batch. Roll it out in this order:

1. Run `npm run migrate` to add the nullable column.
2. Stop old media rollup workers, deploy the new writer, then restart rollups. Do not run old and new rollup writers concurrently during cutover; old writers leave `event_at` null.
3. Repair historical media rows in bounded batches:

```bash
DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run repair:media-event-at -- --dry-run
DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run repair:media-event-at -- --batch-size 1000 --max-rows 10000
```

The media repair is resumable: re-run it until `remainingRows` is `0`. It updates only `namespace = 'media'` rows where `event_at IS NULL` and `metadata.played_at` is a valid offset-aware ISO timestamp. Malformed historical values, including PostgreSQL special timestamp literals such as `now`, are reported as `malformedRows` plus bounded `malformedSamples`; they remain null and are not guessed. During this rollout window, `media_search` queries with `played_after` or `played_before` exclude historical rows whose `event_at` is still null; expect complete bounded played-time results only after `remainingRows` is `0`.

4. Build the event-time search index with the explicit non-transactional operation:

```bash
DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run index:media-event-at
```

This command runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_media_event_at_idx ON public.memories (namespace, event_at DESC) WHERE event_at IS NOT NULL`, which must stay outside `npm run migrate` because PostgreSQL disallows concurrent index creation inside a transaction block.

### Document idempotency rollout

Migration 017 adds nullable document ownership/idempotency columns and the request-hash CHECK without building the unique index in the transaction-wrapped migration. The additive `ALTER TABLE` still takes a brief table lock, so schedule the normal migration window; the potentially longer index build is kept online. Roll it out in this order:

1. Run `npm run migrate` with the owner migration connection.
2. Build the required namespace-scoped unique index with the separate online operation:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run index:document-idempotency
```

This command uses `CREATE UNIQUE INDEX CONCURRENTLY` on `(client_id, namespace, idempotency_key)`, repairs an invalid leftover index on retry, and must complete successfully before the new runtime is deployed. The runtime's `ON CONFLICT` clause depends on this index. Stop old document writers during the final cutover, deploy the new runtime only after the command reports `indexValid: true`, then resume writers. Existing rows remain nullable and are not backfilled; retaining the columns/index during rollback is safe.

### Memory lifecycle rollout and rollback

Migration 024 adds nullable tombstone fields and explicitly named deletion-reason CHECK and deleter FK constraints as `NOT VALID`. It does not validate them inside the transaction-wrapped migration, because the earlier `ALTER TABLE` locks persist until commit, and it leaves both potentially long-running partial indexes to a post-migration online finalizer. Roll out deletion support in this order:

1. Keep memory deletion disabled: do not grant/use the API-key `delete` permission, invoke `memory_forget` or the REST DELETE endpoint, or run `purge:deleted`.
2. Run `npm run migrate` with `MIGRATION_DATABASE_URL` to add the nullable columns and unvalidated constraints, then let the migration transaction commit.
3. Validate both constraints and build both indexes online with the owner migration connection:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run finalize:memory-lifecycle
```

The command runs each `ALTER TABLE ... VALIDATE CONSTRAINT` in a separate autocommit operation, using PostgreSQL's lower-lock validation path only after the migration commits. It then uses `CREATE INDEX CONCURRENTLY`. It verifies exact constraint/index definitions and validity, is safe to retry after partial completion or failed validation, and drops an invalid same-name index left by an interrupted concurrent build. It must report `allValid: true` for `memories_deleted_by_client_id_fkey`, `memories_deletion_reason_length`, `memories_active_namespace_created_idx`, and `memories_deleted_purge_idx`.

4. Deploy and restart **all tombstone-aware processes** before enabling memory deletion: MCP and HTTP servers, watchers, every preseed/import writer, media connectors and rollup workers, decay/re-embedding/repair jobs, and any independently deployed reader or writer that accesses `memories`. Mixed versions are unsafe because an old process can expose, update, or recreate a tombstoned row.
5. Verify ordinary reads and maintenance exclude `deleted_at IS NOT NULL`, then enable deletion by granting/using `delete` permissions. Keep hard purge manual and wait for the retention window.

Before any rollback or incident response, disable `memory_forget`/REST deletion and `purge:deleted` first and stop their callers. If no tombstones have ever been created, the runtime can be rolled back while retaining the additive columns and indexes. Once tombstones exist, application rollback is **roll-forward-only**: do not deploy any binary or job that is not tombstone-aware, do not clear or drop tombstone fields, and repair by deploying corrected tombstone-aware code. After hard purge, deleted content is recoverable only from a verified backup.

### Memory supersession rollout and rollback

Migration 025 is additive and online-safe: it adds nullable supersession columns, `revision`, and the narrow revision trigger, then adds the self-link CHECK and restrictive FK as `NOT VALID`. `NOT VALID` still enforces both constraints for new writes but avoids validating existing rows while the transaction-wrapped migration retains its earlier `ALTER TABLE` lock. The migration deliberately performs no index build or table validation. Roll out supersession in this order:

1. Keep `memory_update` disabled and do not create supersession links.
2. After migration 024 is complete, run `npm run migrate` with the owner-only `MIGRATION_DATABASE_URL` and let migration 025 commit.
3. Complete validation and uniqueness outside the migration transaction:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall npm run finalize:memory-supersession
```

The finalizer runs each `ALTER TABLE ... VALIDATE CONSTRAINT` as a separate autocommit statement, then builds the non-partial `memories_supersedes_id_unique` with `CREATE UNIQUE INDEX CONCURRENTLY` and the historical lookup index with `CREATE INDEX CONCURRENTLY`. It verifies exact definitions and validity, safely resumes partial validation, refuses a wrong valid same-name object, and drops an invalid index left by an interrupted concurrent build before retry. It must report `allValid: true` for both constraints and both indexes. If unique-index creation finds duplicate legacy links, remediate those rows explicitly and rerun the same finalizer; never substitute a partial unique index.
4. Deploy and restart every supersession-aware search/list/recall replica, `memory_update` handler, source-key writer, and re-embedding/maintenance writer. Verify linked UUIDs obey namespace and access-level visibility.
5. Only after all readers and writers are upgraded and the finalizer reported `allValid: true`, enable `memory_update` and create the first link. Enable `SUPERSEDED_SEARCH_DEMOTION_ENABLED=true` only as a separately reviewed ranking rollout; tune `SUPERSEDED_SCORE_FACTOR` only within `(0,1]` (`0.25` is the default and has no effect while the gate is off).

During rollback or incident response, disable `memory_update` and stop link creation first. Before any link exists, the runtime can be rolled back while retaining the additive schema. Once links exist, rollback is roll-forward-only: retain the columns, trigger, indexes, links, durable predecessor markers, and supersession-aware readers; never deploy an old reader that ranks historical rows as current and never drop or clear populated lifecycle fields.

## Namespace Design

| Namespace | Contents | Access |
|-----------|----------|--------|
| `personal` | Life context, preferences, history | Home agents only |
| `work` | Professional context, employer-related | Work + home agents |
| `projects` | Project-specific technical memories | All agents |
| `financial` | Staking, retirement, sensitive | Home agents, restricted |
| `shared` | General knowledge, non-sensitive | All agents |
| `media` | Viewing/listening history rollups from connectors | Home agents |

Media rollups have exactly one kind tag: `music`, `tv`, `movie`, or `unknown`. Classification uses trusted Plex type metadata first, canonical artist/show/episode fields next, and Spotify/YouTube Music play semantics after that; generic events are `unknown` rather than assumed movies. Existing linked rollups can be inspected and optionally repaired without re-embedding content:

```bash
npm run media:repair-tags -- --dry-run --max-rows 10000
# Back up/review first, then apply in bounded batches:
npm run media:repair-tags -- --apply --confirm-backup --batch-size 500 --max-rows 10000
# If limitReached is true, continue from the returned opaque nextCursor:
npm run media:repair-tags -- --apply --confirm-backup --batch-size 500 --max-rows 10000 --cursor '<nextCursor>'
```

Apply refuses to start without `--confirm-backup`: the repair replaces the complete generated tag array from each linked source event, permanently removing custom tags unless they are restored from that backup. It leaves unlinked and non-media-source memories untouched. Continue promptly with each returned `nextCursor` until `limitReached` is false and `nextCursor` is null; until then, repaired and legacy classification tags coexist. The operation is idempotent, and restarting without a cursor safely rescans from the beginning.

Media progress is nullable by design: `duration_ms` describes the item's duration, while absent `played_ms` or `completed` means the provider did not report progress. In particular, Spotify recently-played events retain duration but leave both progress fields `NULL`.

Historical Spotify rows that asserted `played_ms=duration_ms` and `completed=true` are not automatically rewritten because their ingestion provenance is ambiguous. `npm run spotify:repair-progress` is preview-only by default and writes nothing. For an authorized repair, pause Spotify sync, take and verify a restorable backup, independently prove connector provenance per candidate, and create an approval manifest containing only exact previewed event IDs, client IDs, and fingerprints. Apply requires both `--apply --confirm-backup --approval-manifest <file>`; broad predicates, counts, date ranges, and approval of the command itself are rejected. Unverified rows stay unchanged. See [the Spotify connector guide](docs/connectors/spotify.md#historical-progress-repair) for the full workflow.

### Nullable media provider IDs and migration 022

Migration 022 follows migration 021's tenant-local provider identity constraint and makes nullable or blank provider IDs idempotent without collapsing different content played at the same instant. PostgreSQL owns the effective identity: a nonblank `service_id` keeps its exact bytes, while a null/blank ID uses a versioned SHA-256 identity over the stable canonical event fields. Mutable genres, progress, completion, metadata, provenance, agent, and memory-link fields do not alter identity. The migration requires PostgreSQL 16 and owner permission to `CREATE EXTENSION IF NOT EXISTS pgcrypto`; the runtime role receives function execution only and is not granted DDL.

The migration reports counts and aborts if historical effective-identity duplicates exist. It never chooses, merges, or deletes historical rows. This count-only audit uses the same canonical grouping dimensions without exposing private titles:

```sql
WITH identified AS (
  SELECT jsonb_build_object(
    'client', client_id, 'service', service, 'played', played_at,
    'kind', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN 'fallback:v1' ELSE 'id' END,
    'id', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN NULL ELSE service_id END,
    'event_type', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN event_type END,
    'title', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN title END,
    'artist', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN artist END,
    'album', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN album END,
    'show', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN show END,
    'season', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN season END,
    'episode', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN episode END,
    'year', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN year END,
    'duration_ms', CASE WHEN NULLIF(BTRIM(service_id), '') IS NULL THEN duration_ms END
  ) AS identity
  FROM media_events WHERE client_id IS NOT NULL
), groups AS (
  SELECT count(*) AS rows FROM identified GROUP BY identity HAVING count(*) > 1
)
SELECT count(*) AS duplicate_groups, COALESCE(sum(rows), 0) AS duplicate_rows FROM groups;
```

Reconciliation is disabled by default and is never invoked by migration or boot. Its mandatory preview emits an opaque database-generated group key plus bounded event/link IDs and current-state fingerprints, and writes nothing:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall \
  npm run repair:media-event-duplicates -- --max-groups 100 --max-events-per-group 100
```

The normal scan deliberately caps each group at 1,000 rows. If it reports an incomplete oversized group, preview only that exact opaque key with a separately chosen higher safety bound (maximum 100,000); do not increase the global scan bound:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall \
  npm run repair:media-event-duplicates -- --group-key <opaque-key> --target-max-events-per-group 10000
```

Before any apply, stop all media ingestion and rollup workers, take and verify a verified restorable backup, and independently verify every event and linked memory in every complete preview group. Build an explicit approval manifest from that preview: name the opaque `groupKey`, group fingerprint, exact client/service/time, every event and memory ID plus fingerprint, exactly one retained event, exactly one retained linked memory when links exist, and an explicit `retain` or `delete` action for every row. Apply rechecks and locks the exact key. For an oversized targeted approval, repeat its reviewed bound on apply:

```bash
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall \
  npm run repair:media-event-duplicates -- --apply --confirm-backup --approval-manifest ./approved-media-duplicates.json
# Oversized targeted group only:
MIGRATION_DATABASE_URL=postgresql://<owner-role>@<host>:5432/total_recall \
  npm run repair:media-event-duplicates -- --apply --confirm-backup --approval-manifest ./approved-media-duplicates.json --target-max-events-per-group 10000
```

Broad or incomplete approval, ambiguous retention, changed keys or fingerprints, unapproved rows, external memory links, and truncated groups are refused transactionally. Unverified groups remain unchanged and continue to block migration. Re-run preview until it reports zero groups.

For rollout, keep all #8 writers stopped, stage the new binary containing untargeted `ON CONFLICT DO NOTHING`, run owner `npm run migrate`, and start only the new binary. Migration 022 preserves migration 021's tenant-local `media_events_client_service_identity_key` provider constraint as the directly inspectable nonblank-ID invariant even though the effective-identity index overlaps it. Mixed versions are unsafe because the #8 writer's targeted conflict clause does not arbitrate the new expression index. The new expression index is transaction-built and takes a write lock, so use a maintenance window sized for `media_events`; do not run a forced backfill or reindex.

Once new writers resume, migration 022 is **roll-forward-only**: never overlap #8 and #26 writers, and prefer restoring the #26 binary over weakening identity guarantees. If an emergency binary rollback to #8 is unavoidable, keep every media writer stopped, drop `media_events_effective_identity_uidx`, and only then deploy and start the #8 binary. Do not drop migration 021's `media_events_client_service_identity_key`; it is the provider conflict arbiter required by the #8 writer and preserves tenant-local behavior. Drop the helper only after its expression index is gone, and leave `pgcrypto` installed if anything else uses it. This emergency path does not rewrite events, but it removes null/blank-ID fallback deduplication until #26 is rolled forward again.

## Security Model

Access levels are enforced in addition to namespace ACLs. Each key has `max_access_level` (`normal < sensitive < secret`); search, recall, list, namespace counts, stats, and agent memory counts hide rows above that ceiling before pagination or aggregation.

Migration `009_api_key_access_ceiling.sql` preserves existing API key behavior by backfilling existing keys to `secret`, while new keys default to `normal`. Create elevated keys explicitly:

```bash
npm run create-key -- --name "trusted-agent" --namespaces "personal,shared" --max-access-level secret
```

Null legacy memory access levels are normalized to `normal`. Unknown legacy labels are hidden from every key until operators remediate them; the migration adds a `NOT VALID` constraint so new writes must use one of the supported values.

1. **API keys** — unique per client (`tr_` prefix), revocable, SHA256 hashed at rest. MCP tool calls revalidate the key against PostgreSQL, so disabling/deleting a key or changing its namespaces, permissions, or access ceiling takes effect on the next call. A stdio client captures `TOTAL_RECALL_API_KEY` at process startup; replacing that environment secret requires restarting that client, but does not require issuing new credentials when the existing key remains valid. HTTP MCP sessions are bound to the API key that initialized them; another valid key cannot use a captured session ID.
2. **Namespace ACLs** — each key bound to specific namespaces
3. **Row-Level Security** — PostgreSQL RLS policies enforce namespace isolation at the database level
4. **Audit log** — every read/write logged with client ID, agent ID, and timestamp
5. **Recall traces** — every search operation logged with query, results, and timing
6. **No open ports** — Cloudflare Tunnel for external, localhost for internal

## Cortex Dashboard

Total Recall has a dedicated dashboard in Cortex (the personal ops dashboard) at `/memory`:

- **Overview** — Stats, namespace breakdown, source distribution, recent activity
- **Search** — Semantic search with namespace filters
- **Agents** — Agent provenance view (registered agents, memory counts, relationships)
- **Traces** — Recall trace audit trail (queries, results, timing)

## Agent Memory Discipline

Getting agents to *reliably* use memory is harder than building the memory system itself. Total Recall includes guidelines and tooling to close this gap.

**[Agent Memory Guidelines](docs/agent-memory-guidelines.md)** — Copy-paste rules for your agent's system prompt that enforce:
- **Search before guessing** — query Total Recall before making assumptions
- **Store before moving on** — save decisions, preferences, and facts incrementally
- **Self-check before session ends** — review whether key takeaways were stored

**[Discord Sweep](scripts/discord-sweep.py)** — Automated safety net that processes adjacent, per-channel checkpoint windows, extracts noteworthy items via an LLM, and stores them with retry-safe idempotency keys. `--hours` controls only a channel's first lookback; later runs resume from its successful watermark.

```bash
# Dry run to see what would be stored (never changes state or calls storage)
python3 scripts/discord-sweep.py --hours 12 --dry-run

# Production cron (every 6 hours; no overlap buffer is needed)
0 */6 * * * python3 /path/to/discord-sweep.py --hours 6 >> /tmp/discord-sweep.log 2>&1
```

Deploy server support for `memory_store.idempotency_key` before deploying the new cron, then verify through the same `mcporter call total-recall.memory_store` MCP path used by the cron that a keyed response includes `idempotency_key_honored: true`. The cron accepts both mcporter's unwrapped JSON and standard MCP text-content envelope and requires that acknowledgement, so a new cron against an old server retains its pending store and exits nonzero instead of silently checkpointing an unkeyed write. The cron writes state v2 under `~/.cache/discord-sweep/` using a single-process lock and owner-only atomic files. During an interrupted store, that state temporarily contains the normalized extracted memory payload so the retry does not rerun the LLM; it is removed immediately after the window checkpoints. Back up the old state before deployment (migration also creates `state.json.v1.bak`). Rollback requires restoring that legacy backup. Failed channels retain pending state and make the command exit nonzero while independent channels continue. This prevents new duplicates but does not remove historical ones.

`memory_store.idempotency_key` identity is scoped only by the authenticated API key, not by namespace. Reusing a key updates the original row and preserves `created_at`; when the API key is authorized for both the old and new namespaces, this may intentionally move the memory and update its access level. If the existing row is outside the caller's namespace grants, the operation returns the same access-denied error without revealing whether the key already exists.

## Contributor note: stdio output

`src/index.ts` is the stdio MCP entry point. Standard output is reserved exclusively for MCP JSON-RPC transport messages; startup and runtime diagnostics from the entry point and every module it imports must use standard error.

## Development Status

- [x] PostgreSQL + pgvector setup, schema, basic CRUD
- [x] Embedding pipeline (explicit Gemini Embedding 2 descriptor and identity-scoped search)
- [x] MCP server with core tools (store, search, recall, list, stats)
- [x] Auth layer, API keys, namespace ACLs, row-level security
- [x] Pre-seed pipeline (OpenClaw, ChatGPT, Claude, Gemini)
- [x] File sync watcher (MEMORY.md, Cortex content, daily logs)
- [x] Cloudflare Tunnel for external access
- [x] Memory decay and relevance scoring
- [x] Audit logging
- [x] REST API for non-MCP consumers
- [x] Agent provenance model
- [x] Recall trace auditing
- [x] Cortex dashboard integration
- [x] Agent memory guidelines (search/store discipline)
- [x] Discord conversation sweep (automated memory extraction)
- [x] Media connector framework + `media_events` table + rollup job + `media_search` (Phase 1)
- [x] Spotify connector ([setup](docs/connectors/spotify.md)) (Phase 2) — *requires Spotify Premium for the app owner*
- [x] YouTube Music connector via `ytmusicapi` ([setup](docs/connectors/ytmusic.md)) (Phase 3)
- [x] Plex connector via plex.tv account ([setup](docs/connectors/plex.md)) (Phase 2)
- [ ] Netflix quarterly Takeout importer (Phase 4)

## Links
- **Discord:** Total Recall category (general, dev, security, research)
- **Cortex Board:** `total-recall` (violet)

## Stable relevance scores and historical repair

`relevance_base_score` is the stable importance assigned to a memory. `relevance_score`
is only a materialized effective value: base importance decayed by elapsed time plus a
bounded access bonus. Search recalculates that effective value from the stable base at
statement time; the daily decay job materializes the same formula for inspection. An
access increment affects subsequent searches, not the search that selected the row.

Migration 018 deliberately leaves historical base scores unclassified. It changes the
forward formula without resetting or otherwise mutating historical score rows. Decay
will abort without updating anything while any relevance base remains unclassified, so
a missed scheduler pause cannot destroy the facts required by repair. Historical repair
is an owner-operated, approval-gated maintenance procedure and is never run at boot or
by a schedule:

1. Pause decay jobs and deploy migration 018 with the search and decay code together.
2. Begin a maintenance window: freeze search and recall writes. Keep recalls frozen
   through preview, apply, and post-apply verification: access timestamps and counters are
   deliberately part of the strict fingerprint and any recall correctly causes drift.
3. With recalls frozen, run a **fresh preview**:
   `npm run repair:relevance-scores -- --preview relevance-preview.json`. Preview is
   read-only and exports each candidate's exact row ID, current facts, and fingerprint.
4. Separately inventory intentional custom weights and classify every exported row. Do
   not infer ownership from a namespace, count, score, or absence from another export.
5. Take and verify a **verified restorable backup**. Build a manifest with `backupVerified: true`
   and one approval for every candidate using exact IDs and fingerprints. Use
   `reset-managed` (base 1.0), or `preserve-custom` with an independently verified finite
   nonnegative `baseScore`. If the fresh preview proves there are zero candidates, an
   empty approvals array is the exact manifest; apply rechecks the database before safely
   finalizing `NOT NULL`.
6. Run `npm run repair:relevance-scores -- --apply approved-manifest.json`. Verify the
   apply result, constraint, and score distribution before resuming recalls or decay.
   Missing approvals, broad IDs, changed fingerprints, invalid bases, or an unverified
   backup abort the transaction.

Uncertain rows must remain unchanged; they block final `NOT NULL` enforcement rather
than being guessed. Applying an approved manifest recomputes only its exact rows and can
lock rows, generate WAL, and change ranking immediately. Size the maintenance window
from the preview and database lock/WAL budget. No embedding/vector reindex or API-key
reauthentication is required.

All-row decay and re-embedding prefer an operator-only owner/BYPASSRLS
`MAINTENANCE_DATABASE_URL`, then preserve the owner-capable `MIGRATION_DATABASE_URL` and
deprecated `OWNER_DATABASE_URL` compatibility fallbacks. Re-embedding additionally accepts
`REEMBED_DATABASE_URL` as its highest-priority one-command override. When none is set, the
commands use `DATABASE_URL`; an RLS-scoped runtime app role fails the same all-row preflight
rather than partially updating visible namespaces. They run `SET row_security = off` and read
`public.memories` before any provider work. They print only safe identity from
`current_database()` and `current_user` (plus server address), never the connection URL. Do
not grant `BYPASSRLS` to the service role or place maintenance credentials in long-running
service environments. The separately approval-gated relevance repair retains its #34
migration-owner fallback.

Every live store/search/rollup/watcher and preseed process now requires the exact profile
`EMBEDDING_PROVIDER=gemini`, a nonblank `GEMINI_API_KEY`,
`EMBEDDING_MODEL=gemini-embedding-2-preview`, and `EMBEDDING_DIMENSIONS=768`. Dotenv never
overrides shell or service values. Missing or mismatched configuration fails before serving;
a failed Gemini request never falls back to another vector space. Every vector write stores the
provider, model, and dimensions in the same SQL statement. Search compares only rows with the
complete active descriptor; unknown and unsupported rows remain text-only and eligible for text search with no
fabricated cosine score.

For rollout, take a verified restorable backup, apply additive migration
`023_embedding_identity.sql`, audit configuration for the exact profile in every service and operator shell, and
deploy all identity-aware readers/writers before mixed writes begin. Existing descriptors remain
NULL because historical provenance cannot be inferred. Run `npm run reembed` with an owner or
`BYPASSRLS` maintenance connection. Optional controls are `REEMBED_NAMESPACES` (comma-separated;
empty means all, including `media`), `REEMBED_BATCH_SIZE`, `REEMBED_DELAY_MS`,
`REEMBED_MAX_ERRORS` (hard provider/response/database errors only), and
`REEMBED_FULL_REPAIR=true` for deliberate repair of already-labelled rows. Batches preserve the
exact PostgreSQL concurrency token, advance a stable UUID cursor, and atomically commit each new
Gemini vector with its descriptor. Concurrent row changes are reported but do not consume the hard
error budget; the final nonzero exit requests another pass. Interrupted or failed runs are safe to
restart; no command metadata-only relabels uncertain rows.

Pause scheduled decay while the #34 relevance migration/repair is in progress. Run
`npm run decay:update` only after every historical relevance base is classified; it updates
and reports every namespace, including `media` and future names. Re-embedding exits nonzero when
rows fail or scoped verification reports nonzero `unknown_count` or `legacy_count`. Retry failures
and rerun until both counts are zero for the same namespace scope. Only then disable and remove
legacy query profiles and credentials. PostgreSQL maintains HNSW on updates, so no manual index
rebuild is required, but plan for provider cost and substantial WAL/index/IO load.

Rollback cannot reconstruct compounded scores or infer prior custom bases. Keep the
added column and corrected function on application rollback and roll forward. Old code is unsafe
after any repair because it will resume compounding the effective score.

## Nightly memory consolidation

Migration 027 adds restrictive, provenance-preserving consolidation links, immutable membership
history, bounded run state, and owner-key checkpoints. Linked originals are hidden from ordinary
search/list/count/access/decay/re-embedding paths; direct ID recall still returns
`consolidated_into_id` and `consolidated_at`. Active canonicals remain ordinary memories for decay
and future re-embedding. `ON DELETE RESTRICT` and historical memberships prevent purge from
destroying provenance.

No consolidation is enabled implicitly. `npm run consolidate -- --namespace <one> --selection-only`
is credential-free and content-free. Generation requires an owner-only strict #54 policy with a
separately approved provider/model, all privacy/retention/training terms, exactly one normal-only
namespace, dedicated credential reference, unexpired generation approval, bounded invocation
budget, and external monthly control. Apply additionally requires an unexpired write approval and
a dedicated API key with `read,write,delete,consolidate`, exact namespace scope, and
`max_access_level=normal`. Another feature's approval or `GEMINI_API_KEY` never enables it.

The command is bounded and externally scheduled; this repository installs no timer, MCP tool, or
REST operation. Every reader/writer/maintenance process must be upgraded before the first active
link. Rollback stops scheduling and approvals but retains migration 027 and link-aware code;
visibility restoration uses only the exact audited `npm run deconsolidate` manifest workflow.
See [docs/consolidation-rollout-runbook.md](docs/consolidation-rollout-runbook.md).
