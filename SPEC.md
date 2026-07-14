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

With `valid_at`, both vector and text candidates require `valid_from <= valid_at AND (valid_to IS NULL OR valid_at < valid_to)`. Today's supersession demotion is not applied to a predecessor that was valid at that instant. Without it, superseded active history remains eligible but receives `SUPERSEDED_SCORE_FACTOR` (default `0.25`) before final ordering and limiting. Search, list, and recall return additive kind/validity/supersession fields.

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

Classification is optional and fail-open for storage. Before candidate text is read or sent, #53 requires feature-specific approval for the exact provider/model, privacy/retention/training terms, one approved namespace at `normal` access, and a positive approved budget. Up to five current same-namespace semantic candidates at cosine `>=0.85` are supplied as untrusted data to a tool-free bounded classifier. Strict output is exactly one of `duplicate|refinement|contradiction|no_match`, confidence, and one supplied ID (or null for `no_match`). Failures and non-approved results emit content-free outcome codes only.

Automatic supersession defaults off independently of classification. It additionally requires reviewed shadow metrics, explicit mutation approval, and an exact environment gate. Only an approved high-confidence contradiction mutates. The final scoped transaction locks and revalidates the predecessor, inserts the successor, closes the interval, and writes `belief.supersede` audit; a stale candidate inserts normally outside that transaction. Idempotent upserts are classification/shadow eligible but never automatic-mutation eligible.

Rollout is migration 025 and kind-aware writers → `npm run backfill:memory-validity` until pending zero → `npm run finalize:memory-validity` → temporal readers → independently approved shadow classification → reviewed metrics → per-environment mutation approval. Rollback disables mutation, then classification, and never reopens history.

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
