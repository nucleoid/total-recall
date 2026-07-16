# OpenAPI/admin route rollout (#50)

The completed OpenAPI 3.1 contract documents every registered non-MCP REST operation. It also enforces the explicit `admin` permission on global statistics, agent administration, traces, audit, structured media event administration/ingestion, and HTTP-triggered rollup.

## Repository consumer inventory

A repository-wide inventory found no production caller of these HTTP administrative routes. The Spotify, YouTube Music, and Plex jobs call the scoped TypeScript connector/media APIs directly; they continue to require their existing `media` namespace and `write` permission and do not need `admin`. MCP search/store and ordinary Custom GPT search/store actions are unchanged. The three existing Custom GPT operation IDs (`searchMemories`, `storeMemory`, and `storeDocument`) are preserved.

External REST callers cannot be inventoried from this repository. Before deploying:

1. Inspect proxy/access logs for `/api/stats`, `/api/agents`, `/api/traces`, `/api/audit`, `/api/media/events`, and `/api/media/rollup`.
2. Map every caller to an API key owner and desired operation.
3. Prefer migrating ordinary clients to search/store or the internal scoped connector workflow. Grant `admin` only where global administrative access is intentional; also retain `read` or `write` as required by the route.
4. Verify each migrated caller in staging. Confirm ordinary read/write keys receive 403 on administrative routes and remain namespace-confined on search/store.
5. Deploy the server before distributing `openapi.yaml`. Re-import and publish the schema in Custom GPT staging, then test the existing three actions and any newly enabled action.
6. Audit all `admin` grants after rollout.

No database migration, backfill, reindex, or new secret is required. Rollback is the previous server artifact plus the previous published action schema; revoke unnecessary `admin` grants separately rather than leaving them behind.
