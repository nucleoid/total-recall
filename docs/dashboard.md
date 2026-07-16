# Total Recall dashboard

The standalone dashboard is served by the HTTP process at `/dashboard/`. It is separate from the Cortex `/memory` page and requires no cookie or frontend deployment.

## Build and run

```bash
npm ci
npm run build
npm run start:http
# open https://your-total-recall-host/dashboard/
```

`build:dashboard` bundles the static TypeScript and CSS into `dist/dashboard`; the combined `build` command also builds the server. Direct dashboard URLs such as `/dashboard/memories` return the SPA shell. The shell is `no-cache`; hashed assets are immutable. `/api/*` and `/mcp` are never dashboard fallback routes.

When proxying through Cloudflare, preserve the `/dashboard/` and `/api/` paths on the same origin and HTTPS host. Do not inject an API key at the proxy, in HTML, or in a query parameter. The server sets a same-origin CSP, frame denial, `nosniff`, and a no-referrer policy.

## Authentication and permissions

Enter an existing `tr_…` bearer key at the gate. By default the key exists only in JavaScript memory. “Remember for this tab” uses `sessionStorage`; the dashboard never uses `localStorage`, cookies, URLs, source markup, or build-time settings for credentials. Logout and API 401/403 responses clear the key.

Capabilities come from `GET /api/capabilities` without returning the key ID or secret:

- `read`: browse, inspect, and search accessible active memories.
- `write`: edit memory content. Content edits regenerate the embedding. Every PATCH requires an `If-Match` precondition containing the quoted `updated_at` value.
- `delete`: soft-delete after typing the full memory ID. Retention and hard-purge behavior remain the server's lifecycle contract.
- `admin` + `read`: global overview, agents, recall traces, audit records, and media statistics.

Memory list/get queries always enforce the key's namespace and access-level ceiling. Tombstones are never disclosed. Trace detail labels scores as recorded retrieval evidence and omits inaccessible, expired, deleted, or superseded memory summaries.

## Screens

- **Overview** — accessible count/capabilities, or global statistics for an admin.
- **Memories** — server-paginated filtering and allowlisted sorting; inspect provenance; edit/delete when permitted.
- **Search** — debounced hybrid search with stale-request cancellation.
- **Recall traces** — query, agent/session/timing, result order, stored score components, and accessible result summaries.
- **Media** — date/service-capable API aggregates for events, listening duration, services, artists, albums, tracks, and UTC days.
- **Agents / Audit** — administrative activity views.

All dynamic values are inserted with DOM text APIs, not HTML parsing. The interface supports keyboard navigation, native modal focus behavior, visible focus, responsive layout, light/dark color schemes, live errors, and reduced motion.

## API additions

See `openapi.yaml` for `GET /api/memories`, `GET/PATCH /api/memories/{id}`, `GET /api/traces/{id}`, `GET /api/media/stats`, and `GET /api/capabilities`. Media date bounds are inclusive. Listening duration uses `played_ms`, falling back to `duration_ms` only for events explicitly marked complete; music rankings require a non-null artist.
