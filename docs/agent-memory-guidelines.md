# Agent Memory Guidelines

Best practices for configuring AI agents to actively use Total Recall for persistent memory. These rules are designed to be added to your agent's system prompt, `AGENTS.md`, or equivalent instruction file.

## The Problem

AI agents wake up fresh each session. Without explicit guidance, they:
- Forget decisions made in prior conversations
- Re-ask questions that were already answered
- Lose institutional knowledge that was discussed but never stored
- Default to guessing instead of checking stored context

Total Recall solves the storage problem. These guidelines solve the *discipline* problem — making agents reliably search and store.

## Search Guidelines

Add these rules to your agent instructions to ensure it queries Total Recall before making assumptions.

```markdown
### When to SEARCH (memory_search)

**HARD RULE: Search before guessing.** If you're not 100% certain about something,
search Total Recall first. Your memory across sessions is limited — Total Recall is
your actual long-term brain. Searching is cheap; wrong assumptions are expensive.

**Always search when:**
- Starting a conversation about any specific topic or project
- The user references something you should know but don't have in session context
- Working on a project — search for past decisions, preferences, architecture choices
- You're about to suggest an approach but aren't sure if it's been tried/rejected before
- Someone mentions a person, tool, or concept you don't have full context on
- You're about to ask the user a question — check if the answer is already stored
- A task feels ambiguous — prior conversations likely clarified it
- You're making a technical choice (library, pattern, config) — past preferences may exist

**Search patterns:**
- Broad topic: `memory_search("project-name")`
- Specific decision: `memory_search("project-name architecture decision")`
- Person context: `memory_search("person-name role")`
- Past preference: `memory_search("preferred approach for X")`

**Rule of thumb:** If you'd search the web for it in a normal job, search Total Recall
here. Your stored memories are your institutional knowledge — use them.
```

## Agent Identity (Provenance)

Every `memory_store` and `memory_search` call should pass `agent_name` so the operation is attributed to the agent performing it. Without this, every memory looks like it came from the same anonymous source.

**Pass these fields on every call:**
- **`agent_name`** *(strongly recommended)* — unique identifier for the agent (e.g. `"openclaw"`, `"cursor-dev"`, `"claude-code-mobile"`)
- **`agent_runtime`** *(optional)* — the platform running the agent (e.g. `"claude-code"`, `"cursor"`, `"openclaw"`)
- **`agent_model`** *(optional)* — the LLM model (e.g. `"claude-opus-4-7"`)
- **`session_id`** *(optional)* — groups related operations within a conversation

Total Recall will fall back to the API key's name if `agent_name` is missing, but explicit values give cleaner provenance and let you track multiple sub-agents under one key.

```bash
# Example: explicit agent identity
mcporter call total-recall.memory_store --args '{
  "content": "Decided to use Postgres pgvector over Pinecone",
  "namespace": "projects",
  "tags": ["architecture", "database"],
  "agent_name": "my-coding-agent",
  "agent_runtime": "claude-code",
  "agent_model": "claude-opus-4-7"
}'
```

## Storage Guidelines

Add these rules to ensure agents store important context incrementally, not just at session end.

```markdown
### When to STORE (memory_store)

Store **summarized, distilled** information — not raw conversation dumps.
Think "what would future-me need to know?"

**HARD RULE: Store before moving on.** After any of the following, store to
Total Recall before continuing the conversation:
1. A decision is made (technical choice, architecture, approach)
2. A preference or opinion is expressed ("I prefer X", "don't do Y", "always use Z")
3. A project milestone is reached (deployed, shipped, merged, signed)
4. A lesson is learned or mistake is identified
5. A key fact about a person, relationship, or plan is revealed
6. A new project, tool, or workflow is introduced

**Don't wait for the end of the conversation.** Store incrementally as items come up.
If you're unsure whether something is worth storing, store it — over-storing is better
than losing context.

**Always store:**
- Important decisions and their rationale
- User preferences and opinions
- Project milestones and outcomes
- Lessons learned / mistakes to avoid
- Key facts about people, relationships, plans
- New project names, codenames, or initiatives

**Never store:**
- Trivial chit-chat or greetings
- Information already in workspace files
- Sensitive credentials or API keys
- Raw conversation transcripts

### Storage tips
- **Summarize first** — condense a 20-message exchange into 2-3 key takeaways
- **Tag well** — include project names, people, topics for better retrieval
- **Lean toward storing** — when in doubt, store it
- **Be quiet about it** — don't announce every search/store unless asked
- **Self-check before session ends** — mentally review: did I store the key takeaways?
```

## Forget Guidelines

Use `memory_forget` only when a stored fact is wrong, sensitive, or explicitly requested to be removed. Prefer exact `ids`; filter-only deletion requires `confirm: true` and should be narrowed carefully. Never assume `write` authorizes deletion—the agent's key needs a separately granted `delete` permission. Selectors combine with AND, `before` is strict, and tags use AND containment.

A successful forget is a tombstone, not immediate hard deletion. Do not retry `memory_store` with the same source/idempotency key to restore it; restoration is a separate operator-controlled audited operation. Ordinary recall will no longer return forgotten chunks. If every chunk of a document is forgotten, treat document recall as not-found.

## Automated Sweep (Safety Net)

In-session discipline will never be 100%. For chat platforms where message history persists (Discord, Slack, etc.), you can run a periodic sweep that re-reads recent conversations and extracts anything worth storing.

See [`scripts/discord-sweep.py`](../scripts/discord-sweep.py) for a reference implementation that:
- Reads half-open, adjacent windows from Discord channel logs, checkpointed by stable channel ID
- Uses an LLM to extract decisions, preferences, facts, and lessons
- Persists a temporary owner-only extraction snapshot and uses keyed `memory_store` retries
- Advances a channel only after extraction and all stores succeed; other channels continue on failure
- Runs as a cron job (recommended: every 4-8 hours; `--hours` is first-run lookback only)

Deploy keyed server support before the cron and verify the acknowledgement through the same `mcporter call total-recall.memory_store` MCP path the cron uses. Every keyed response must include `idempotency_key_honored: true`; the sweep unwraps either direct JSON or the standard MCP text-content envelope and refuses to checkpoint without the acknowledgement, which makes a misordered new-cron/old-server rollout fail closed. State v2 is atomically stored in the owner-only `~/.cache/discord-sweep/` directory and the local pending payload is deleted immediately after a successful checkpoint. A dry run neither changes state nor calls storage. The first real run backs up valid legacy state; retain that backup for rollback. This catches context that slipped through in-session storage. It's a safety net, not a replacement for the discipline rules above.

For general callers, an idempotency key is scoped to the authenticated API key rather than a namespace. Reuse updates the same memory and preserves its original `created_at`; a caller granted both namespaces may intentionally move that row and update its access level. Reuse cannot reveal or mutate a row whose current namespace is outside the caller's grants: it returns the normalized access-denied response.

## Architecture of Memory Reliability

```
                  ┌─────────────────────────┐
                  │   In-Session Storage     │  ← Primary: agent stores as it goes
                  │   (hard rules above)     │
                  └───────────┬─────────────┘
                              │
                  ┌───────────▼─────────────┐
                  │   Automated Sweep        │  ← Safety net: periodic cron job
                  │   (discord-sweep.py)     │     catches what sessions missed
                  └───────────┬─────────────┘
                              │
                  ┌───────────▼─────────────┐
                  │   File Watcher           │  ← Background: syncs workspace
                  │   (total-recall-watcher) │     files automatically
                  └───────────┬─────────────┘
                              │
                  ┌───────────▼─────────────┐
                  │   Total Recall DB        │
                  │   (PostgreSQL + pgvector)│
                  └─────────────────────────┘
```

The three layers provide defense in depth:
1. **In-session rules** catch things in real time (highest quality, but depends on agent discipline)
2. **Automated sweeps** review chat logs periodically (catches gaps, but slightly lower quality extraction)
3. **File watcher** keeps workspace documents synced (automatic, but only covers files — not conversations)

## Known Gaps

- **Non-chat sessions** (e.g., Claude Code, Cursor) don't have persistent logs that a sweep can review. These rely entirely on in-session discipline.
- **LLM extraction quality** in sweeps depends on the model used. Haiku is fast and cheap but may miss nuance. Consider Sonnet for important channels.
- **Duplicate detection** relies on Total Recall's built-in deduplication (cosine similarity > 0.92). In practice, near-duplicates occasionally slip through — this is acceptable.
