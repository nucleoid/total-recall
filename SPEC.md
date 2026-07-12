# Total Recall — MCP Memory Server

## Overview
Universal AI memory system. Postgres/pgvector backend, MCP server interface, API key auth with namespace ACLs.

## Stack
- **Runtime:** Node.js + TypeScript
- **Database:** PostgreSQL 16 + pgvector (HNSW)
- **Embedding:** nomic-embed-text (768d) via Ollama (localhost:11434)
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

### memory_list
List memories with filters (no vector search).
- namespace?: string
- source?: string
- tags?: string[]
- limit?: number (default 20)
- offset?: number

### memory_forget
Delete memories by ID or filter.
- ids?: string[]
- namespace?: string
- before?: string
- tags?: string[]

### memory_stats
Get usage statistics.
- namespace?: string

## Embedding Pipeline
- Ollama API: POST http://localhost:11434/api/embed
- Model: nomic-embed-text
- Returns 768-dimensional vector
- Batch support for bulk ingestion

## Hybrid Search Query
```sql
SET LOCAL hnsw.ef_search = 200;

WITH vector_results AS (
  SELECT id, content, metadata, tags, source, namespace, created_at,
    1 - (embedding <=> $1) AS vec_score
  FROM memories
  WHERE namespace = ANY($2)
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
The canonical variables below are for the currently gated preseed/repair commands. Live readers and writers still select Ollama when no Gemini key is present until #9 identity storage and #61 mixed-aware readers permit a coordinated cutover.

```
# Runtime and preseed app role; migration/maintenance credentials are separate.
DATABASE_URL=postgresql://total_recall_app:total_recall_app_dev@localhost:5432/total_recall
MIGRATION_DATABASE_URL=postgresql://total_recall:total_recall_dev@localhost:5432/total_recall
CLAUDE_IMPORTS_DIR=/absolute/path/to/claude-export
OPENCLAW_WORKSPACE=/absolute/path/to/.openclaw/workspace
OPENCLAW_CORTEX_CONTENT=/absolute/path/to/cortex/content
OPENCLAW_SECOND_BRAIN=/absolute/path/to/second-brain
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key-here
EMBEDDING_MODEL=gemini-embedding-2-preview
EMBEDDING_DIMENSIONS=768
HNSW_EF_SEARCH=200
```

## Build & Run
```bash
npm install
npm run build
npm run migrate
npm run create-key -- --name "openclaw" --namespaces "personal,work,shared" --max-access-level normal
node dist/index.js
```

Migration `009_api_key_access_ceiling.sql` backfills existing `api_keys.max_access_level` values to `secret` to preserve upgraded installations, then sets the default for newly created keys to `normal`. Use `--max-access-level sensitive` or `--max-access-level secret` only for clients that should read and write higher-classification memories.

## Preseed Import Safety
After the #9/#61 gate opens, preseed commands use `DATABASE_URL` and reject any superuser,
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
7. Preseed and repair remain fail-closed until #9 identity storage and #61 mixed-aware readers exist; unknown rows are text-only
8. Migration completion requires zero active legacy/unknown rows before operators disable legacy querying
