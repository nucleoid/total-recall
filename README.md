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
List all registered agents with memory counts and last activity.

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
3. Use `agent_list` to see all registered agents and their memory counts

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

## REST API

All endpoints require authentication via `Authorization: Bearer tr_<key>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/search` | Hybrid semantic + keyword search |
| POST | `/api/store` | Store a single memory |
| POST | `/api/store-document` | Store a chunked document |
| GET | `/api/stats` | Memory statistics (admin) |
| GET | `/api/agents` | List registered agents |
| POST | `/api/agents` | Register/update an agent |
| GET | `/api/traces` | Paginated recall traces |
| GET | `/api/audit` | Paginated audit log |

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

### Pre-Seed (one-time bulk import)
Bootstrap from existing AI conversation history across platforms.

| Source | Script | Format | Status |
|--------|--------|--------|--------|
| OpenClaw | `preseed-openclaw.ts` | Markdown files | Done |
| ChatGPT | `preseed-chatgpt.ts` | JSON export | Done |
| Claude | `preseed-claude.ts` | JSON export | Done |
| Gemini | `preseed-gemini.ts` | HTML export | Done |

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

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Database | PostgreSQL 16 + pgvector | Battle-tested, vector search built-in, HNSW indexes |
| Embedding | Gemini Embedding 2 (768d) | High quality, free tier. Fallback: Ollama nomic-embed-text |
| Protocol | MCP (Model Context Protocol) | Standard for LLM tool integration |
| REST API | Express 5 | For non-MCP consumers (Cortex dashboard, Custom GPTs) |
| Auth | API keys + namespace ACLs + RLS | Per-client scoping with row-level security |
| External Access | Cloudflare Tunnel | No open ports, TLS, access policies |
| File Watcher | chokidar (Node.js) | Efficient inotify-based, handles nested dirs |
| Deployment | systemd (user services) | Simple, reliable, auto-restart |

## Namespace Design

| Namespace | Contents | Access |
|-----------|----------|--------|
| `personal` | Life context, preferences, history | Home agents only |
| `work` | Professional context, employer-related | Work + home agents |
| `projects` | Project-specific technical memories | All agents |
| `financial` | Staking, retirement, sensitive | Home agents, restricted |
| `shared` | General knowledge, non-sensitive | All agents |

## Security Model

1. **API keys** — unique per client (`tr_` prefix), revocable, SHA256 hashed at rest
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

**[Discord Sweep](scripts/discord-sweep.py)** — Automated safety net that periodically re-reads Discord channel logs, extracts noteworthy items via LLM, and stores them. Run as a cron job to catch anything that in-session storage missed.

```bash
# Dry run to see what would be stored
python3 scripts/discord-sweep.py --hours 12 --dry-run

# Production cron (every 6 hours, 1h overlap buffer)
0 */6 * * * python3 /path/to/discord-sweep.py --hours 7 >> /tmp/discord-sweep.log 2>&1
```

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

## Links
- **Discord:** Total Recall category (general, dev, security, research)
- **Cortex Board:** `total-recall` (violet)
