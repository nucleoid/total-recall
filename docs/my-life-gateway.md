# My Life historical retrieval gateway

This repository owns the local MCP gateway in `src/archive/`. My Life owns the
index, import adapters, source permissions, portable storage and citation API.
Existing Total Recall database schemas and memory tools are unchanged.

Build with `npm run build:server`, then run `npm run --silent start:gateway` as the
assistant’s **local stdio Total Recall connection**, with these private settings:

| Setting | Purpose |
|---|---|
| `TOTAL_RECALL_UPSTREAM_URL` | Existing Total Recall Streamable HTTP MCP endpoint; HTTPS required except numeric loopback |
| `TOTAL_RECALL_API_KEY` | Existing scoped memory-service credential |
| `MYLIFE_RETRIEVAL_URL` | My Life origin, such as `http://127.0.0.1:8799`; numeric loopback only |
| `MYLIFE_RETRIEVAL_TOKEN` | Dedicated archive capability whose hash is in My Life’s external policy |
| `MYLIFE_ARCHIVE_ID` | Expected archive identity; a different drive fails closed |

Use an absolute path to `dist/archive/gateway.js` in the client’s MCP stdio
configuration. This process requires no Total Recall database credentials,
Docker socket or archive filesystem mount. It does not load `.env` implicitly;
the client supplies its private environment. Run a separate process and archive
grant for each differently authorized client. This is not a multi-user HTTP
proxy or public tunnel. Local search can disclose excerpts to the connected
assistant; My Life’s explicit `assistant_excerpts` grant authorizes that boundary.

The gateway passes supported existing memory tools through unchanged. It adds:

- `context_search`: combined memory and archive evidence, with per-provider
  status and coverage. Configure personal/project/history prompts to use this
  tool. `memory_search` retains its existing contract.
- `context_recall`: route a `memory:` or `my-life:` reference to its provider.
- `archive_status`: inspect authorized My Life indexing coverage or offline state.

```json
{
  "query": "integration",
  "limit": 12,
  "memory_filters": {"namespaces": ["work", "shared"]},
  "archive_filters": {"kinds": ["email", "calendar", "facebook", "linkedin"]}
}
```

Omit `archive_filters.kinds` to query all granted providers, including future
ones. The API does not enumerate a closed provider list. Photos include retained
metadata, not inferred image content. Facebook/LinkedIn include undated records
from the optional structured-import adapter. My Life detects those tables when
the separate importer work lands. No importer code is duplicated here.

Archive search is currently lexical with English stopword/stemming support and
an explicitly labelled any-term fallback for plain queries with no initial match.
Quoted/excluded/OR syntax is preserved. A no-lexical-match marker is not evidence
of historical absence. Use focused keywords, names or identifiers.
The assistant can make several focused searches for a complex question. Rank
fusion combines provider ranks, not incompatible embedding scores. A returned
memory’s `created_at` is not an event date. Memory `after`/`before` preserve their
creation-date semantics; archive bounds filter historical event starts. Use
Calendar `occurrences` for dates/recurrences and `records` for cancellations,
older revisions or components that cannot be projected. Unknown dates remain
unknown; appointments do not prove attendance.

The original query alone is sent to the memory provider; retrieved archive
excerpts are never sent upstream as query expansion. `sources: ["archive"]`
does not call the memory provider. Search performs no memory write. Saving an
archive summary remains an explicit `memory_store` action: retain archive refs
in `metadata.archive_refs`, historical dates, verification status, and whether
the summary is observation or inference. A summary and its cited source are
not independent corroboration.

Provider failure does not erase successful results from the other provider.
Responses distinguish offline, timeout, absent configuration and rejected
capabilities. Invalid individual archive rows are dropped with partial coverage;
archive identity mismatch still fails closed. Archive identity, bounded response
size and citation shape are validated. Neither archive HTTP redirects nor upstream HTTP redirects are
followed with credentials. Errors do not echo provider response bodies, queries
or secrets. A failed upstream write is never automatically retried. A per-request
timeout leaves the shared MCP transport open for concurrent calls. If a dispatched
write times out or loses transport, `write_outcome_unknown` directs the caller to
reconcile using its idempotency key before retrying; it does not imply no write occurred.

My Life’s search verifies stored evidence hashes. Its email/Calendar recall also
verifies original bytes and replays extraction. Other source adapters currently
retain indexed hashes and parser provenance with
`original_bytes_rechecked: false`; the gateway preserves that distinction.

Run `node --test --import tsx test/archive-gateway.test.ts` after installing
dependencies. My Life’s `tests/retrieval-db.test.ts`, with
`TOTAL_RECALL_WORKTREE` set to this built checkout, exercises this actual HTTP
adapter against a migrated synthetic PostgreSQL archive and combines its
results with a synthetic memory provider. This verifies the shared interface
without accessing personal data or the production memory service.

My Life shares a three-second database deadline across strict and relaxed search.
The adapter uses a 15-second network timeout by default and accepts only 5�30
seconds when configured programmatically. Search budget exhaustion is partial
coverage (`search_incomplete`), not evidence of absence. Status can report
`worker_stopped` while already indexed evidence is still searchable. Results
preserve top-level `event_time.precision` and source-bound citation IDs; month,
year and all-day bounds must not be interpreted as exact event instants.
