# Connecting Total Recall to Your LLM Tools

Total Recall uses the MCP (Model Context Protocol) standard. Each tool connects via a JSON config that tells it where the MCP server lives and how to authenticate.

## API Keys

Each tool gets its own key with scoped namespace access:

| Client | Key Name | Namespaces |
|--------|----------|------------|
| Cass (OpenClaw) | openclaw-v2 | personal, work, projects, financial, shared |
| ChatGPT | chatgpt-work | work, shared |
| Claude | claude-work | work, shared |
| Gemini | gemini-personal | personal, projects, shared |

Keys are printed once on creation. If lost, create a new one:
```bash
cd ~/projects/total-recall
npx tsx scripts/create-key.ts --name "client-name" --namespaces "ns1,ns2"
```

Total Recall revalidates authentication and ACLs for every MCP tool call. Disabling or deleting a key, or changing its namespaces, permissions, or access ceiling, therefore applies on the next call. Local stdio clients keep the `TOTAL_RECALL_API_KEY` value with which their process started, so replacing that environment secret requires restarting the client process. Remote HTTP MCP sessions are bound to the key that initialized them; after a server restart clients must initialize a new in-memory session, but they can keep using the same valid API key.

Database credentials are separate from Total Recall API keys. Runtime clients use the `total_recall_app` `DATABASE_URL`; never put owner-only `MIGRATION_DATABASE_URL` or one-shot `APP_DATABASE_PASSWORD` in these client configurations. A coordinated database-password rotation requires restarting each DB-backed process with its updated `DATABASE_URL`, but the API keys shown below remain unchanged.

---

## 1. OpenClaw (Cass)

OpenClaw supports MCP servers natively via mcporter. Already configured at:
`~/.openclaw/workspace/config/mcporter.json`

Or add to your OpenClaw config:

```yaml
mcp:
  servers:
    total-recall:
      command: node
      args:
        - /home/fuego/projects/total-recall/dist/index.js
      env:
        TOTAL_RECALL_API_KEY: "tr_<your-openclaw-key>"
        DATABASE_URL: "postgresql://total_recall_app:<app-password>@localhost:5432/total_recall"
        EMBEDDING_PROVIDER: "gemini"
        GEMINI_API_KEY: "<your-gemini-key>"
        EMBEDDING_MODEL: "gemini-embedding-2-preview"
        EMBEDDING_DIMENSIONS: "768"
```

### System Prompt Addition (AGENTS.md or equivalent)

Add to your agent's instructions:

```
## Memory (Total Recall)
You have access to a persistent memory system via MCP tools.

**On every conversation start:**
- Call `memory_search` with key topics from the user's message to recall relevant context
- Use recalled memories to personalize your responses

**During conversation — store when you encounter:**
- User preferences or opinions ("I prefer X over Y")
- Important decisions ("We decided to use Postgres")
- Key facts about people, projects, or plans
- Lessons learned or mistakes to avoid
- Technical choices and their rationale

**How to store:**
- Single facts/preferences → `memory_store` with appropriate namespace and tags
- Full documents the user pastes → `memory_store_document` with a descriptive title
- Always include relevant tags for better retrieval later

**Namespaces:**
- personal — life context, preferences, history
- work — professional, job-related
- projects — technical project details
- financial — money, investments, retirement (sensitive)
- shared — general knowledge
```

---

## 2. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "total-recall": {
      "command": "node",
      "args": ["/home/fuego/projects/total-recall/dist/index.js"],
      "env": {
        "TOTAL_RECALL_API_KEY": "tr_<your-claude-work-key>",
        "DATABASE_URL": "postgresql://total_recall_app:<app-password>@localhost:5432/total_recall",
        "EMBEDDING_PROVIDER": "gemini",
        "GEMINI_API_KEY": "<your-gemini-key>",
        "EMBEDDING_MODEL": "gemini-embedding-2-preview",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

**For remote access** (work laptop over Cloudflare Tunnel):
Once the tunnel is set up, use the HTTP URL instead:
```json
{
  "mcpServers": {
    "total-recall": {
      "url": "https://recall.stakewatch.dev/mcp",
      "headers": {
        "Authorization": "Bearer tr_<your-claude-work-key>"
      }
    }
  }
}
```

### Custom Instructions (Claude Desktop → Settings → Custom Instructions)

```
You have access to a memory system called Total Recall via MCP tools.

At the start of each conversation:
- Search memories relevant to the topic using memory_search
- Use what you find to give more personalized, context-aware responses

During conversation, store important information:
- My preferences, decisions, and opinions → memory_store (namespace: "work" or "shared")
- Documents I paste for you to remember → memory_store_document
- Always add descriptive tags

You have access to "work" and "shared" namespaces. Store work-related things in "work", general knowledge in "shared".

Don't announce that you're searching/storing unless I ask. Just do it naturally.
```

---

## 3. Claude Code (CLI)

Add to `~/.claude.json` (global) or `CLAUDE.md` in your project:

**MCP Config (`~/.claude.json`):**
```json
{
  "mcpServers": {
    "total-recall": {
      "command": "node",
      "args": ["/home/fuego/projects/total-recall/dist/index.js"],
      "env": {
        "TOTAL_RECALL_API_KEY": "tr_<your-key>",
        "DATABASE_URL": "postgresql://total_recall_app:<app-password>@localhost:5432/total_recall",
        "EMBEDDING_PROVIDER": "gemini",
        "GEMINI_API_KEY": "<your-gemini-key>",
        "EMBEDDING_MODEL": "gemini-embedding-2-preview",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

**CLAUDE.md (project-level instructions):**
```markdown
## Memory
You have Total Recall MCP tools available. When working on this project:
- Search memories at the start of each task for relevant context, past decisions, and preferences
- Store significant architectural decisions, technical choices, and lessons learned
- Use namespace "projects" for project-specific memories, "work" for general professional context
- Tag memories with the project name and relevant technologies
```

---

## 4. Cursor

**MCP Config (`.cursor/mcp.json` in project root or global settings):**

```json
{
  "mcpServers": {
    "total-recall": {
      "command": "node",
      "args": ["/home/fuego/projects/total-recall/dist/index.js"],
      "env": {
        "TOTAL_RECALL_API_KEY": "tr_<your-key>",
        "DATABASE_URL": "postgresql://total_recall_app:<app-password>@localhost:5432/total_recall",
        "EMBEDDING_PROVIDER": "gemini",
        "GEMINI_API_KEY": "<your-gemini-key>",
        "EMBEDDING_MODEL": "gemini-embedding-2-preview",
        "EMBEDDING_DIMENSIONS": "768"
      }
    }
  }
}
```

**`.cursorrules` (project-level instructions):**
```
You have access to Total Recall memory tools via MCP.

When starting a coding task:
- Search memories for relevant past decisions, coding patterns, and preferences
- Check for any "lessons learned" or "avoid this" memories related to the current tech stack

When making significant decisions:
- Store architectural choices and their rationale using memory_store
- Tag with project name and technologies involved
- Use namespace "projects"

Don't narrate memory operations. Just search and store silently.
```

---

## 5. ChatGPT

ChatGPT doesn't natively support MCP (as of early 2026). Options:

**Option A: Custom GPT with Actions (recommended)**
Once Cloudflare Tunnel is live (task #245), create a Custom GPT:
1. Go to ChatGPT → Explore GPTs → Create
2. Add Actions pointing at `https://recall.stakewatch.dev/`
3. Import the OpenAPI spec (we'll generate one)
4. Set the API key in authentication

**Option B: ChatGPT MCP support**
OpenAI has been adding MCP support — check if it's available in your ChatGPT plan. If so, configure like Claude Desktop with the HTTP URL.

### Custom GPT Instructions
```
You have access to a personal memory system called Total Recall.

ALWAYS at the start of each conversation:
- Use the memory_search action to find relevant context about the topic
- This helps you give personalized responses based on the user's history

During conversation, store important things the user tells you:
- Preferences, decisions, opinions → memory_store (namespace: "work" for professional, "shared" for general)
- Documents or long text to remember → memory_store_document
- Include descriptive tags on everything

You have access to "work" and "shared" namespaces only.

Be natural about it — don't announce every search or store operation.
```

---

## 6. Gemini CLI

Gemini CLI supports MCP natively via SSE/HTTP transport. Add to your `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "total-recall": {
      "url": "https://recall.stakewatch.dev/mcp",
      "headers": {
        "Authorization": "Bearer tr_<your-gemini-key>"
      }
    }
  }
}
```

### Gemini Web App
The Gemini web app doesn't support custom MCP servers yet. For now, use Gemini CLI or wait for Google to add support.

### Custom Instructions (Gemini Gems or system prompt)
```
You have access to a memory system called Total Recall via MCP tools.

At the start of conversations, search for relevant memories about the topic using memory_search.

Store important information the user shares:
- Preferences and opinions → memory_store (namespace: "personal" or "projects")
- Documents to remember → memory_store_document
- Tag everything descriptively

You have access to "personal", "projects", and "shared" namespaces.

Don't announce memory operations — integrate recalled context naturally.
```

---

## Proactive memory notifications

Approved agents can use `agent_subscribe` to register a public HTTPS callback for future semantic matches, `agent_list_subscriptions` to inspect redacted destinations and counts, and `agent_unsubscribe` to stop delivery. Treat the one-time signing secret like a credential, verify `X-Total-Recall-Signature` over the exact body, deduplicate by event ID, and call `memory_recall` with the receiver's own key for content. See [docs/subscriptions.md](docs/subscriptions.md); subscription creation is operator-gated and disabled by default.

## Remote Access (Cloudflare Tunnel)

For tools running on your work laptop (not on the home server):

1. **Cloudflare Tunnel** → exposes Total Recall as `https://recall.stakewatch.dev`
2. **HTTP/SSE MCP transport** → port 3003 (systemd service running)
3. **API key in header** → `Authorization: Bearer tr_<key>`

Remote configs use the HTTP URL instead of local `command: node`:
```json
{
  "total-recall": {
    "url": "https://recall.stakewatch.dev/mcp",
    "headers": {
      "Authorization": "Bearer tr_<your-key>"
    }
  }
}
```

Much simpler for remote tools — no local Node.js needed, just an HTTP endpoint.

---

## Testing a Connection

After configuring any tool, test with:

1. Ask the AI: "Search my memories for ethereum staking"
2. It should call `memory_search` and return results
3. Then: "Remember that I prefer dark mode in all apps"
4. It should call `memory_store` with namespace based on its key's permissions

If it doesn't work:
- Check the tool's MCP server logs
- Verify the API key is correct
- Ensure Postgres is running and the configured Gemini credential can reach the Gemini API
- For remote: verify Cloudflare Tunnel is up (`curl https://recall.stakewatch.dev/health`)

---

## The Key Insight

**Connecting MCP gives tools the *ability* to use memories. The system prompt gives them the *habit*.**

No tool will automatically search/store without being instructed to. The system prompt snippets above are what make Total Recall actually useful — they tell each AI to:
1. **Search first** — check memories before responding
2. **Store naturally** — save important things as they come up
3. **Be quiet about it** — don't narrate every memory operation

Copy the relevant system prompt snippet when setting up each tool.
