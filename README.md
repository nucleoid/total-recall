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

This rotation changes only the PostgreSQL app-role password. Total Recall API keys remain unchanged, so it causes no API-key reauthentication or token replacement. After migration 020, `total_recall_app` holds live DELETE capability on `memories`, constrained by namespace RLS, ahead of the #51 consumer; this issue exposes no deletion tool or endpoint and #51 owns that lifecycle. There is no memory backfill or reindex, and no data is deleted by this rollout. The additive policy migration remains safe if application code is rolled back.

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
        │  • memory_search            │
        │  • memory_recall            │
        │  • memory_list              │
        │  • memory_list_namespaces   │
        │  • memory_stats             │
        │  • agent_register           │
        │  • agent_list               │
        │                             │
        │  REST API:                  │
        │  • POST /api/search         │
        │  • POST /api/store          │
        │  • POST /api/store-document │
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
Document chunks are stored with `normal` access unless document classification is added in a later schema/API change. The decoded limit is enforced consistently by the MCP and REST schemas (400 for invalid decoded content). HTTP JSON envelope limits are independent and can reject a request earlier with 413; this change does not raise the server's transport parser limit.

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

### `memory_recall`
Get a specific memory by ID, or all chunks of a document by `document_id`.

### `memory_list`
Browse/paginate memories with optional filters (no vector search).

### `memory_list_namespaces`
List available namespaces and their memory counts.

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

Agent and trace listing endpoints are scoped to the authenticated API key. Shared namespaces do not expose another key's provenance rows.

## REST API

All endpoints require authentication via `Authorization: Bearer tr_<key>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/search` | Hybrid semantic + keyword search |
| POST | `/api/store` | Store a single memory |
| POST | `/api/store-document` | Store a chunked document |
| GET | `/api/stats` | Memory statistics (admin) |
| GET | `/api/agents` | List registered agents for the key |
| POST | `/api/agents` | Register/update an agent |
| GET | `/api/traces` | Paginated recall traces for the key |
| GET | `/api/audit` | Paginated audit log |
| POST | `/api/media/search` | Vector search over media (viewing/listening) history |
| POST | `/api/media/events` | Upsert media events (used by connectors) |
| GET | `/api/media/events` | List structured media events with filters |
| POST | `/api/media/rollup` | Trigger pending events → summary memories |

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
- Restart the watcher after changing the root. Existing `file-sync` rows are not rewritten or removed, so audit/back up rows before changing an established root and stop duplicate watcher instances first.

**Sync mechanics:**
- `sync_state` table tracks `file_path → content_hash` using `/`-separated, workspace-relative identities on every OS. The same portable identity is used for metadata and source keys.
- Native absolute paths are used only for filesystem access and Chokidar.
- On change: re-chunk, re-embed, **upsert** (deterministic ID from `source_file + heading_path`)
- Symlinks are followed. Containment is lexical rather than a security boundary: a symlink below the workspace may point outside it.
- No duplicates, no stale entries

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
| OpenClaw | `preseed-openclaw.ts` | Markdown files | Gated on #9 |
| ChatGPT | `preseed-chatgpt.ts` | JSON export | Gated on #9 |
| Claude | `preseed-claude.ts` | JSON export | Gated on #9 |
| Gemini | `preseed-gemini.ts` | HTML export | Gated on #9 |

Preseed commands currently fail closed before reading exports, connecting to PostgreSQL, or calling an embedding provider. Issue #9 must first supply the approved embedding-identity schema and atomic vector+descriptor writer; issue #61 mixed-aware readers must then be deployed everywhere before preseed can create mixed-vintage writes. #41 deliberately does not guess column names or stamp provenance onto vectors whose identity is unknown.

After that gate opens, Claude and OpenClaw preseed require the least-privileged app-role `DATABASE_URL`; never provide `MIGRATION_DATABASE_URL`, a superuser, a `BYPASSRLS` role, or the owner of `memories`. Both commands verify the connected role before reading sensitive source files. Each group contains at most ten fully embedded rows; only then does it begin a transaction, set the exact JSON `app.allowed_namespaces` subset transaction-locally, upsert, and commit. Provider work never holds a database transaction, failures roll back the current group, and no namespace context survives client reuse. This changes only operator command credentials: API keys, sessions, and user reauthentication are unaffected.

Claude requires `CLAUDE_IMPORTS_DIR` (or one directory argument) containing required `conversations.json` and `memories.json`. Empty Claude arrays, absent or empty `chat_messages`, and absent or blank `conversations_memory` produce an explicit zero-write successful summary. Missing files, malformed JSON/shapes, and invalid importable timestamps fail nonzero. Memory content without a valid conversation date uses `--memory-timestamp <ISO timestamp>` when supplied; this explicit operator value takes precedence over the once-captured `memories.json` mtime, which is the fallback when the option is absent.

OpenClaw requires `OPENCLAW_WORKSPACE` (or one directory argument). `OPENCLAW_CORTEX_CONTENT` and `OPENCLAW_SECOND_BRAIN` optionally override their defaults beneath the workspace. Discovered files are canonicalized and deduplicated before batching, including alternate paths.

Once that gate is implemented, ChatGPT import requires `CHATGPT_IMPORTS_DIR` or a directory as the first CLI argument. The directory scanner accepts only `conversations.json` and `conversations-<digits>.json` (unsuffixed first, then numeric suffix order); backups and unrelated files are ignored. Each root array is streamed one conversation at a time, output chunks are committed in batches of at most ten, and reruns converge through stable source keys. A failed later file or batch leaves earlier batches committed. The default single-conversation limit is 16 MiB; `--max-conversation-bytes <bytes>` permits an explicit positive override up to 64 MiB, with correspondingly higher Node heap risk.

#### Gemini Takeout identity and historical repair

After the same #9/#61 gate is implemented, set `GEMINI_TAKEOUT_HTML_PATH` (or pass one HTML path) and run `npm run preseed:gemini`. The importer preserves the existing `Q: …\n\nA: …` format and 4,000-character cap, then assigns `gemini-conv:v2:<sha256>` from the exact persisted content and normalized UTC instant. Export reorder or prepend therefore cannot renumber existing conversations. Prompt/response differences beyond 4,000 characters are indistinguishable and cannot be recovered from historical rows.

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
Gated preseed embedder (explicit Gemini gemini-embedding-2-preview, 768d)
    ↓
PostgreSQL + pgvector (upsert)
```

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Database | PostgreSQL 16 + pgvector | Battle-tested, vector search built-in, HNSW indexes |
| Embedding target | Gemini `gemini-embedding-2-preview` (768d) | Canonical target for gated preseed/repair; live fallback remains until #9/#61 |
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

Migration files are immutable after distribution. The runner records the SHA-256 of each file's exact bytes and stops before pending migrations if applied history is changed, missing, renamed, malformed, or ambiguous. On the first checksum-aware run, legacy ledger rows are baselined atomically from the reviewed checkout. This trust boundary cannot detect edits made before that baseline, so run it only from a reconciled, immutable release. The sole reviewed compatibility exception is the exact pre-#49 checksum of migration 003: the runner records its sanitized checkout checksum under the advisory lock, while migration 020 carries the DELETE grant/policy forward for databases where 003 was already applied. No other checksum drift is accepted.

Migration runners serialize on a database-local advisory lock before reading or upgrading the ledger and hold it through the last migration. `MIGRATION_LOCK_TIMEOUT_MS` controls the bounded wait (default `30000`, accepted range `1`–`600000` milliseconds). A timeout makes no ledger or schema changes; increase it only when the expected migration duration justifies a longer deployment wait.

A checksum mismatch is an operational stop, not a prompt to overwrite the ledger. Restore the exact migration file from the reviewed release, inspect the ledger and actual schema, then make any required change through an audited forward repair migration. Connection loss can make commit acknowledgement ambiguous, so inspect both schema and ledger before retrying. Rolling back to the old runner ignores checksums and removes drift and concurrency protection; leave the additive `checksum` column in place and restore the checksum-aware runner instead.

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
- [x] Embedding pipeline (Gemini Embedding 2 + Ollama fallback)
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
deprecated `OWNER_DATABASE_URL` compatibility fallbacks. When none is set, they use
`DATABASE_URL`; an RLS-scoped runtime app role fails the same all-row preflight rather than
partially updating visible namespaces. The commands run `SET row_security = off` and read
`public.memories` before doing any work. They print only safe identity from
`current_database()` and `current_user` (plus server address), never the connection URL. Do
not grant `BYPASSRLS` to the service role or place maintenance credentials in long-running
service environments. The separately approval-gated relevance repair retains its #34
migration-owner fallback.

Live store/search/rollup embedding loads dotenv without overriding shell or service
environment values. To avoid mixed writes before #9 and #61, those existing paths retain their
current import-time provider selection until the coordinated cutover. Do not switch their provider
piecemeal. Canonical preseed and repair require `EMBEDDING_PROVIDER=gemini`, a nonblank
`GEMINI_API_KEY`, `EMBEDDING_MODEL=gemini-embedding-2-preview`, and
`EMBEDDING_DIMENSIONS=768`; their gates currently stop before use. Once mixed-aware rollout is
possible, a failed Gemini request must never fall back to another vector space. Audit configuration
in every HoT service and operator shell before rollout and record the audit.

`npm run reembed` is currently gated and exits nonzero before provider or database access. Do not
remove that gate until #9 identity storage exists and #61 mixed-aware readers are deployed on every
instance. Then take a verified restorable backup, inventory vector vintages, and prove the intended
maintenance database and provider capacity. Unknown rows are text-only until actually re-embedded;
never assign them a guessed legacy or target identity.

Pause scheduled decay while the #34 relevance migration/repair is in progress. Run
`npm run decay:update` only after every historical relevance base is classified; it updates
and reports every namespace, including `media` and future names. After #9 and #61 are delivered,
repair must claim bounded batches, generate canonical vectors outside the transaction, and commit
each vector with its complete descriptor atomically. Retry failures without metadata-only stamps.
Do not declare rollout complete until verification reports **zero active legacy/unknown** rows.
Only then disable and remove legacy query profiles and credentials. PostgreSQL maintains HNSW on
updates, so no manual index rebuild is required, but plan for substantial WAL/index/IO load.

Rollback cannot reconstruct compounded scores or infer prior custom bases. Keep the
added column and corrected function on application rollback and roll forward. Old code is unsafe
after any repair because it will resume compounding the effective score.
