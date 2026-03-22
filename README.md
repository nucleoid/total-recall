# Total Recall

Universal AI memory system — a single source of truth for every AI tool and agent in your life.

## Vision

Every AI tool you use (OpenClaw, Cursor, Claude, work tools) operates in isolation with no shared memory. Total Recall fixes that: a centralized, vectorized memory store with an MCP interface that any LLM or AI tool can plug into. What you tell one agent, all agents can recall — with proper access controls.

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
        │                             │
        │  Tools:                     │
        │  • memory_store             │
        │  • memory_store_document    │
        │  • memory_search            │
        │  • memory_recall            │
        │  • memory_list_namespaces   │
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
        │  │ documents           │    │
        │  │ ─────────────────── │    │
        │  │ id          UUID PK │    │
        │  │ title       TEXT    │    │
        │  │ source      TEXT    │    │
        │  │ namespace   TEXT    │    │
        │  │ tags        TEXT[]  │    │
        │  │ chunk_count INT     │    │
        │  │ created_at  TS      │    │
        │  └─────────────────────┘    │
        │                             │
        │  ┌─────────────────────┐    │
        │  │ sync_state          │    │
        │  │ ─────────────────── │    │
        │  │ file_path   TEXT PK │    │
        │  │ content_hash TEXT   │    │
        │  │ last_synced  TS     │    │
        │  └─────────────────────┘    │
        └─────────────────────────────┘
```

## MCP Tools

### `memory_store`
Store a single memory/fact with metadata.
```json
{
  "content": "Mitch prefers Besu+Lodestar for ETH validation (minority clients)",
  "source": "openclaw-conversation",
  "namespace": "personal",
  "tags": ["ethereum", "staking", "preference"]
}
```

### `memory_store_document`
Chunk and store a full document. Auto-splits by headings (markdown) or paragraphs (plain text), embeds each chunk, links them with a shared `document_id` for full-doc retrieval.
```json
{
  "title": "NZ Tax Residency Rules",
  "content": "<full document text>",
  "namespace": "personal",
  "tags": ["tax", "nz", "immigration"],
  "source": "manual"
}
```
Use case: copy/paste a document into any LLM prompt and call this tool to store it.

### `memory_search`
Hybrid semantic + keyword search with filters.
```json
{
  "query": "what validator clients does Mitch use",
  "namespace": "personal",
  "limit": 5,
  "min_score": 0.7
}
```

### `memory_recall`
Get a specific memory by ID, or all chunks of a document by `document_id`.

### `memory_list_namespaces`
List available namespaces and their memory counts.

## Data Sources & Sync Model

### Automatic (MCP — ongoing)
Once connected, every LLM tool stores memories through MCP in real-time. No sync needed.

### File Sync (watcher/cron — ongoing)
Key files are monitored for changes, diffed by content hash, chunked, and upserted.

**Watched files:**
- `MEMORY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` → `personal` / `projects`
- `memory/*.md` (daily logs) → `personal` + `projects`
- Cortex content: `journals/`, `concepts/`, `projects/`, `documents/` → mixed namespaces

**Sync mechanics:**
- `sync_state` table tracks `file_path → content_hash`
- On change: re-chunk, re-embed, **upsert** (deterministic ID from `source_file + heading_path`)
- No duplicates, no stale entries

**Explicitly excluded:**
- Task deliverables (credentials, API keys, sensitive outputs)
- `.env` files, token/secret files
- Anything in `.git/`

### Pre-Seed (one-time bulk import)
Bootstrap from existing AI conversation history across platforms.

**Phase 1: OpenClaw / Cass** (richest, most structured)
- Sources: `MEMORY.md`, `USER.md`, `TOOLS.md`, `memory/*.md`, `second-brain/`
- Chunking: heading-based splits (each `##` = a memory, `###` stays grouped unless >500 tokens)
- Daily logs get timestamp metadata for temporal queries
- Deduplicate: MEMORY.md (curated) takes priority over daily files (raw)

**Phase 2: ChatGPT** (best export format)
- Export: Settings → Data Controls → Export Data → `conversations.json`
- Parse turn-pairs, filter by information density (skip mechanical debugging loops)
- OpenAI's "remembered facts" are gold — pure distilled preferences, highest priority
- Namespace auto-classification by conversation topic

**Phase 3: Claude** (Anthropic)
- Export: claude.ai → Settings → Export Data → JSON dump
- Same turn-pair extraction and density filtering
- No structured "memories" feature to extract (yet)

**Phase 4: Gemini** (Google)
- Export: Google Takeout → Gemini Apps → HTML files per conversation
- HTML parser needed (messiest format)
- Gemini's memory/facts feature may or may not be in the export

### Manual (CLI — ad hoc)
```bash
recall ingest <file>           # One-off file import
recall ingest --dir <path>     # Bulk directory import
```

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
Embedder (Gemini Embedding 2 via API, fallback to Ollama nomic-embed-text)
    ↓
PostgreSQL + pgvector (upsert)
```

### Conflict Resolution
- **Latest timestamp wins** — most recent preference/fact is authoritative
- Source platform stored in metadata for provenance tracking

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Database | PostgreSQL + pgvector | Battle-tested, vector search built-in, no extra service |
| Embedding | Gemini Embedding 2 (gemini-embedding-2-preview) | High quality, free tier, 768d vectors. Falls back to Ollama nomic-embed-text if no API key |
| MCP Server | TypeScript/Node.js | MCP SDK is TypeScript-first, matches existing stack |
| Auth | API keys + namespace ACLs | Simple, auditable, per-client scoping |
| External Access | Cloudflare Tunnel | No open ports, TLS, access policies, already have CF |
| File Watcher | chokidar (Node.js) | Efficient inotify-based, handles nested dirs |
| Deployment | systemd service | Consistent with Cortex, simple, reliable |

## Namespace Design

| Namespace | Contents | Access |
|-----------|----------|--------|
| `personal` | Life context, preferences, history | Home agents only |
| `work` | HoT-related, professional context | Work + home agents |
| `projects` | Project-specific technical memories | All agents |
| `financial` | Staking, retirement, sensitive | Home agents, restricted |
| `shared` | General knowledge, non-sensitive | All agents |

## Security Model

1. **API keys** — unique per client, revocable
2. **Namespace ACLs** — each key can only access permitted namespaces
3. **Encryption at rest** — Postgres TDE or application-level for sensitive namespaces
4. **Encryption in transit** — TLS via Cloudflare Tunnel (external) or local UNIX socket
5. **Audit log** — every read/write logged with client ID and timestamp
6. **Rate limiting** — per-client rate limits to prevent abuse
7. **No open ports** — Cloudflare Tunnel for external, localhost/VPN for internal

## Development Phases

- [ ] **Phase 1:** Postgres + pgvector setup, schema, basic CRUD
- [ ] **Phase 2:** Embedding model selection and pipeline (nomic-embed-text)
- [ ] **Phase 3:** MCP server with core tools (store, search, store_document)
- [ ] **Phase 4:** Auth layer, API keys, namespace ACLs
- [ ] **Phase 5:** Pre-seed pipeline (OpenClaw → ChatGPT → Claude → Gemini)
- [ ] **Phase 6:** File sync watcher (MEMORY.md, Cortex content, daily logs)
- [ ] **Phase 7:** Cloudflare Tunnel for external access
- [ ] **Phase 8:** Advanced features (decay, consolidation, dedup, CLI)

## Links
- **Discord:** Total Recall category (general, dev, security, research)
- **Cortex Board:** `total-recall` (violet)
