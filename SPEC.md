# Total Recall — MCP Memory Server

## Overview
Universal AI memory system. Postgres/pgvector backend, MCP server interface, API key auth with namespace ACLs.

## Stack
- **Runtime:** Node.js + TypeScript
- **Database:** PostgreSQL 16 + pgvector (HNSW)
- **Embedding:** Gemini `gemini-embedding-2-preview` (768d), explicitly configured
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Auth:** API key → namespace ACL mapping

## Database

Connection: `postgresql://total_recall:total_recall_dev@localhost:5432/total_recall`

Extensions already installed: `vector`, `uuid-ossp`

### Schema

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(768),
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  source TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'shared',
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  access_level TEXT DEFAULT 'normal',
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_count INT DEFAULT 0
);

CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 256);

CREATE INDEX ON memories USING gin (tags);
CREATE INDEX ON memories (namespace, created_at DESC);
CREATE INDEX ON memories (source);
CREATE INDEX ON memories (client_id);
CREATE INDEX ON memories USING gin (to_tsvector('english', content));

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  namespaces TEXT[] NOT NULL DEFAULT '{shared}',
  permissions TEXT[] NOT NULL DEFAULT '{read,write}',
  max_access_level TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  enabled BOOLEAN DEFAULT true
);
```

### HNSW Config
- m = 32 (connections per node)
- ef_construction = 256 (build quality)
- SET hnsw.ef_search = 200 at query time

## MCP Tools

### memory_store
Store a memory with automatic embedding.
- content: string (required)
- namespace?: string (default 'shared')
- source?: string (auto-set from client)
- tags?: string[]
- metadata?: Record<string, any>
- access_level?: 'normal' | 'sensitive' | 'secret'

The API key's `max_access_level` must be greater than or equal to the requested `access_level`. Reads compare ranks as `normal < sensitive < secret`; rows above the key ceiling are excluded from search, recall, list, namespace counts, stats, and agent memory counts before pagination or aggregation. Null legacy memory values are treated as `normal`; unknown legacy labels fail closed and are not visible to any key.

### memory_update
Patch an active current memory. Requires `write`, a UUID `id`, and at least one supplied patch field.
- content?: nonblank string (maximum 100,000 characters; re-embedded only when changed)
- tags?: string[] (complete replacement, including `[]`)
- metadata?: Record<string, any> (complete replacement, including `{}`)
- supersedes?: UUID (immutable predecessor link)

Omitted fields are unchanged and unknown/null fields are rejected. Namespace, source, access level, provenance, document/source identity, creation/deletion state, and lifecycle links are immutable. Both sides of a supersession must be authorized, active/current, distinct, and in the same namespace; each predecessor has at most one successor ever. One transaction locks IDs in UUID order, closes the predecessor and links the successor at one database timestamp, and writes content-free `memory.update` and `belief.supersede` audits. With the #53 validity columns present, that same timestamp sets predecessor `valid_to`/`superseded_at` and successor `valid_from`, creating contiguous half-open intervals even when the successor was stored earlier. The writer probes for the complete validity column set before constructing DML: all absent selects the pre-#53 shape, a partial set fails closed, and unrelated SQL failures propagate. Changed content is embedded before locking and committed only if the trigger-owned `revision` still matches.

Historical active rows remain listable and directly recallable. Results expose `supersedes_id`, visible active `superseded_by_id`, `superseded_at`, `is_superseded`, and `revision`; either linked UUID is null unless the linked row is active, in the requested namespace, and visible at the caller's access-level ceiling. Search builds separate bounded current/historical vector and text candidates, then, only when the separate `SUPERSEDED_SEARCH_DEMOTION_ENABLED=true` rollout gate is enabled, multiplies historical final scores by validated `SUPERSEDED_SCORE_FACTOR` in `(0,1]` (default `0.25`) before ordering and limiting. Eligibility thresholds are unchanged. Source-key writers cannot rewrite superseded rows, forgetting/purging a successor does not clear its predecessor marker, and the `ON DELETE RESTRICT` link blocks predecessor purge while referenced.

### memory_store_document
Store a nonblank document of at most **1 MiB decoded UTF-8**. Chunking prefers markdown heading and paragraph boundaries, then hard-splits on Unicode code-point boundaries. It is lossless and every embedding chunk is at most **2,000 UTF-8 bytes**. MCP and REST use the same decoded-content schema; an HTTP transport may independently reject an oversized JSON envelope before schema validation.
- title: string (required)
- content: string (required)
- namespace?: string (default `shared`)
- source?: string (default `manual`)
- tags?: string[]
- idempotency_key?: string

A retry with the same request returns the completed document only while all original chunks remain active. If any visible chunk has been deliberately tombstoned, the retry returns the stable typed `idempotency_key_tombstoned` conflict (HTTP 409) and never restores chunks. A physical chunk-count mismatch without tombstones remains an incomplete-write conflict. Namespace RLS and the pre-query authorization check keep inaccessible documents and chunks undisclosed.

### memory_search
Hybrid vector + full-text search.
- query: string (required)
- namespaces?: string[] (default: all accessible)
- limit?: number (default 10, max 50)
- threshold?: number (minimum similarity, default 0.3)
- tags?: string[] (AND filter)
- source?: string
- after?: string (ISO date)
- before?: string (ISO date)
- valid_at?: string (strict offset-aware ISO-8601 instant; available after validity finalization)

With `valid_at`, both vector and text candidates require `valid_from <= valid_at AND (valid_to IS NULL OR valid_at < valid_to)`. Historical searches never apply present-day supersession demotion. Ordinary search preserves current and historical candidate pools, but only applies `SUPERSEDED_SCORE_FACTOR` before final ordering/limiting when the separate `SUPERSEDED_SEARCH_DEMOTION_ENABLED=true` rollout gate is set; the restrictive default is false. Search probes catalogs before constructing SQL and uses the #52/legacy shape when migration 026 is absent. Only a fully finalized positive capability set is cached, with bounded TTL and database-pool generation; partial/negative states are re-probed, pool changes and an explicit hook invalidate it, and `valid_at` always refreshes finalization. It does not catch SQL failures, and `valid_at` fails closed until validity finalization. Search, list, and recall return additive kind/validity/supersession fields once their schema is deployed.

### memory_list
List memories with filters (no vector search).
- namespace?: string
- source?: string
- tags?: string[]
- limit?: number (default 20)
- offset?: number

### memory_forget
Soft-delete authorized active memories. Requires the explicit `delete` API-key permission; `write` does not imply `delete`.
- ids?: UUID[] (1–100, unique after normalization)
- namespace?: string
- before?: offset-aware ISO date-time (strict `created_at < before`; future values rejected)
- tags?: nonempty string[] (AND containment)
- confirm?: boolean (must be `true` whenever `ids` is absent)
- reason?: string (1–512 characters; never emitted in audit/log output)

At least one selector is required and selectors combine with AND. A transaction locks at most 101 authorized matches and rejects more than 100 without mutation. It returns only newly tombstoned IDs and a count; inaccessible and absent IDs are indistinguishable. Tombstones are excluded from all ordinary reads, counts, search/access updates, and maintenance writes. Source-key upserts cannot restore them. Each newly forgotten row receives one content-free `memory.forget` audit row atomically.

Hard purge has a fixed 30-day retention window and is a separately invoked, preview-first maintenance command. It uses an explicit namespace inventory, deterministic bounded batches, a session advisory lock, state fingerprints, and per-row `memory.purge` audit. Referenced tombstones are retained and reported. No automatic purge schedule is enabled.

### memory_stats
Get usage statistics.
- namespace?: string

## Belief Revision and Validity

`memory_kind` is one of `unspecified`, `semantic`, `document_chunk`, `synced`, `media_rollup`, or `consolidation`. Only ordinary `memory_store` writes `semantic`; only those rows can participate in contradiction classification. Validity is half-open `[valid_from, valid_to)`, and automatic contradiction uses one database timestamp for the predecessor's `superseded_at`/`valid_to` and the successor's `valid_from`.

Classification is optional and fail-open for storage but fail-closed for provider egress. Before candidate text is read or sent, #53 requires feature-specific approval for the exact provider/model, privacy/retention/training terms, one approved namespace at `normal` access, a positive process-lifetime cap, and explicit conservative request/input/output estimate rates. The gateway returns no authoritative spend, so `CONTRADICTION_COST_BUDGET_USD` is enforced as an integer-micro-USD reservation cap, not reported as exact billing: before egress the process atomically reserves fixed request estimate + actual bounded input-byte estimate + maximum output-byte estimate, never refunds ambiguous/provider-failed attempts, and resets accounting only with the process lifecycle. One approved configuration owns the process runtime; in-process cap/rate/provider/scope/scheduler drift fails closed instead of creating another budget or concurrency partition. Exhaustion stores normally without egress. Up to five current same-namespace semantic candidates at cosine `>=0.85` are supplied as untrusted data to a tool-free bounded classifier. Strict output is exactly one of `duplicate|refinement|contradiction|no_match`, confidence, and one supplied ID (or null for `no_match`). Failures and non-approved results emit content-free outcome codes only.

Automatic supersession defaults off independently of classification. It additionally requires reviewed shadow metrics, explicit mutation approval, and an exact environment gate. Only an approved high-confidence contradiction mutates. The final scoped transaction locks and revalidates the predecessor, inserts the successor, closes the interval, and writes `belief.supersede` audit; a stale candidate inserts normally outside that transaction. Idempotent upserts are never classification or mutation eligible. Shadow-only classification is scheduled best-effort after an unkeyed normal store commits and excludes that new row from its candidates. A process-wide scheduler bounds active and queued shadows; saturation skips work, while shutdown rejects new work, drops queued work, and drains active calls. Mutation-enabled unkeyed stores classify synchronously before the atomic revision because they can consume the result. All runtime reasons are fixed content-free codes.

Rollout is #52 migration 025/readers/writers → migration 026 and kind-aware writers with every #53/search-ranking gate off → bounded validity backfill (standalone rows from `created_at`, linked successors from predecessor `superseded_at`) → owner finalizer (concurrent unique/index builds plus deferred validation) → temporal readers → optional superseded-row demotion → independently approved conservative budget model and bounded shadow classification → reviewed metrics → per-environment mutation approval. Rollback disables mutation and drains requests, disables classification and drains up to its timeout, disables demotion, then disables `valid_at`; it retains all additive lifecycle state and never reopens history. A pre-#52 reader is forbidden once any supersession link exists.

## Embedding Pipeline
- Gemini API: `embedContent` / `batchEmbedContents`
- Model: `gemini-embedding-2-preview`, output dimensionality 768
- Explicit provider/model/dimensions validation; no credential-driven fallback
- Scalar and batch response cardinality, dimension, and finite-number validation
- Vector and complete descriptor are written atomically

## Hybrid Search Query
```sql
SET LOCAL hnsw.ef_search = 200;

WITH vector_results AS (
  SELECT id, content, metadata, tags, source, namespace, created_at,
    1 - (embedding <=> $1) AS vec_score
  FROM memories
  WHERE namespace = ANY($2)
    AND embedding_provider = 'gemini'
    AND embedding_model = 'gemini-embedding-2-preview'
    AND embedding_dimensions = 768
  ORDER BY embedding <=> $1
  LIMIT 50
),
text_results AS (
  SELECT id,
    ts_rank_cd(to_tsvector('english', content), plainto_tsquery($3)) AS text_score
  FROM memories
  WHERE namespace = ANY($2)
    AND to_tsvector('english', content) @@ plainto_tsquery($3)
)
SELECT v.*,
  (v.vec_score * 0.7 + COALESCE(t.text_score, 0) * 0.3) AS final_score
FROM vector_results v
LEFT JOIN text_results t ON v.id = t.id
ORDER BY final_score DESC
LIMIT $4;
```

## Project Structure
```
total-recall/
├── src/
│   ├── index.ts          # MCP server entry point
│   ├── db.ts             # Database connection + queries
│   ├── embedding.ts      # Canonical Gemini embedding client
│   ├── search.ts         # Hybrid search logic
│   ├── auth.ts           # API key validation + namespace ACL
│   ├── tools/
│   │   ├── store.ts
│   │   ├── search.ts
│   │   ├── list.ts
│   │   ├── forget.ts
│   │   └── stats.ts
│   └── types.ts
├── scripts/
│   ├── migrate.ts        # Run DB migrations
│   ├── create-key.ts     # Generate API key
│   └── seed.ts           # Optional test data
├── migrations/
│   └── 001_initial.sql
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Environment Variables
The canonical embedding variables are mandatory for every runtime, watcher, preseed, and re-embedding command. Missing or mismatched values fail before embedding work; no provider is inferred from credential presence.

```
# Runtime and preseed app role; owner migration credentials are separate.
DATABASE_URL=postgresql://total_recall_app:<app-password>@localhost:5432/<database>
MIGRATION_DATABASE_URL=postgresql://<owner-role>:<owner-password>@localhost:5432/<database>
# One-shot provisioning/rotation input; never retain in runtime environments.
APP_DATABASE_PASSWORD=<new-app-password>
CLAUDE_IMPORTS_DIR=/absolute/path/to/claude-export
OPENCLAW_WORKSPACE=/absolute/path/to/.openclaw/workspace
OPENCLAW_CORTEX_CONTENT=/absolute/path/to/cortex/content
OPENCLAW_SECOND_BRAIN=/absolute/path/to/second-brain
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key-here
EMBEDDING_MODEL=gemini-embedding-2-preview
EMBEDDING_DIMENSIONS=768
HNSW_EF_SEARCH=200
# Optional one-command owner/BYPASSRLS override for npm run reembed:
REEMBED_DATABASE_URL=postgresql://<owner-role>:<owner-password>@localhost:5432/<database>
```

## Build & Run
```bash
npm install
npm run build
# Owner-only, before the first migration (add -- --rotate-app-password only for a coordinated rotation):
npm run provision
npm run migrate
npm run create-key -- --name "openclaw" --namespaces "personal,work,shared" --max-access-level normal
node dist/index.js
```

Schema migrations use only owner-capable `MIGRATION_DATABASE_URL`; runtime services use the least-privileged `DATABASE_URL`; all-row decay and repair use an explicitly verified maintenance-capable connection. The numbered migration runner preflights schema creation and ownership of existing managed tables and never promotes the runtime role. The obsolete standalone decay DDL command must not be restored.

### Memory lifecycle rollout and rollback

Deletion remains disabled while operators run `npm run migrate`. Migration 024 adds the explicitly named deletion-reason CHECK and deleter FK as `NOT VALID` and does not validate either inside the transaction-wrapped migration, where earlier `ALTER TABLE` locks persist until commit. After migration commit, operators run `npm run finalize:memory-lifecycle` with the owner connection. The finalizer verifies definitions and validity, validates each constraint in a separate autocommit `ALTER TABLE ... VALIDATE CONSTRAINT` using PostgreSQL's lower-lock path, then builds both partial indexes concurrently. Failed validations, partial completion, and invalid interrupted-index leftovers are safely verified and retried through the same command; both constraints and both indexes must report valid. Operators must then deploy and restart all tombstone-aware processes—servers, watchers, importers, connectors/rollups, and maintenance readers/writers—before enabling memory deletion through `delete` permissions or invoking forget. Mixed tombstone-aware and unaware processes are unsupported.

Disable forget/REST deletion and purge first during incident response or rollback. Before any tombstone is created, retaining the additive fields/indexes permits an application rollback. Once tombstones exist, rollback is **roll-forward-only**: every process must remain tombstone-aware, tombstone fields must remain intact, and fixes deploy forward. Hard-purged content is recoverable only from a verified backup.

### Memory supersession rollout and rollback

Keep `memory_update` disabled and create no links while rolling out #52. After migration 024 is complete, run `npm run migrate`: migration 025 adds nullable revision/supersession fields and the narrow trigger, and adds the self-link CHECK and restrictive FK as `NOT VALID`, which enforces new writes without scanning existing rows under the migration transaction's retained `ALTER TABLE` lock. It performs no index build or `VALIDATE CONSTRAINT`.

Next, with the owner-only `MIGRATION_DATABASE_URL`, run `npm run finalize:memory-supersession`. In separate autocommit operations the finalizer runs `ALTER TABLE ... VALIDATE CONSTRAINT`, builds the canonical durable non-partial `memories_supersedes_id_unique` guarantee with `CREATE UNIQUE INDEX CONCURRENTLY`, and builds the historical lookup index concurrently. The later validity finalizer verifies or idempotently reuses this canonical unique index rather than creating a duplicate. It verifies exact definitions and validity, resumes partial completion, rejects wrong valid same-name objects, and repairs an invalid interrupted index on retry. Both constraints and both indexes must report `allValid: true`; duplicate legacy links must be explicitly remediated before retrying.

Deploy and restart every supersession-aware reader, update handler, source-key writer, and maintenance writer only after finalization, then enable `memory_update` and link creation. During rollback, disable `memory_update` and stop link creation first. Before the first link, retaining the additive schema permits runtime rollback. After the first link, rollback is roll-forward-only: retain the schema, demotion behavior, and history, and never deploy old readers or clear/drop lifecycle fields.

Migration `009_api_key_access_ceiling.sql` backfills existing `api_keys.max_access_level` values to `secret` to preserve upgraded installations, then sets the default for newly created keys to `normal`. Use `--max-access-level sensitive` or `--max-access-level secret` only for clients that should read and write higher-classification memories.

## Preseed Import Safety
After migration 023 and identity-aware readers are deployed, preseed commands use `DATABASE_URL` and reject any superuser,
`BYPASSRLS` identity, or owner of `memories` before reading exports. They embed bounded groups
before beginning a transaction, set only that group's `app.allowed_namespaces` transaction-locally,
and roll back the complete group on failure. Owner credentials remain exclusive to migrations and
explicit all-row maintenance.

Empty Claude exports are successful zero-write imports: empty conversation/memory arrays, absent
or empty `chat_messages`, and absent or blank `conversations_memory` report zero. Missing files and
malformed shapes remain errors. A memory-only export uses the captured `memories.json` mtime or
requires explicit `--memory-timestamp`; run time is never substituted. Claude uses
`CLAUDE_IMPORTS_DIR`. OpenClaw uses `OPENCLAW_WORKSPACE`, with optional
`OPENCLAW_CORTEX_CONTENT` and `OPENCLAW_SECOND_BRAIN` overrides; canonical paths are deduplicated.

## Key Requirements
1. All embedding happens server-side (client sends plain text)
2. Namespace isolation enforced at query level via API key ACLs
3. Hybrid search combines vector similarity (70%) + full-text ranking (30%)
4. HNSW index with high ef_search for best real-time recall
5. Access tracking (accessed_at, access_count) updated on search hits
6. Embedding is explicitly Gemini `gemini-embedding-2-preview` at 768 dimensions; failures never fall back across vector spaces
7. Vector candidates require the exact stored provider/model/dimensions descriptor; unknown or unsupported rows are text-only
8. Preseed and re-embedding atomically write vectors with the canonical descriptor, never metadata-only relabel uncertain rows
9. Migration completion requires zero scoped active legacy/unknown rows before operators disable legacy querying
