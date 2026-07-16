# Browser history connector

The browser connector imports **visit rows** from one explicitly selected Chromium/Chrome or Firefox profile into the private `activity_events` domain. It never writes browser activity to `media_events` or media rollups.

## Privacy and ownership

Create a dedicated key with the smallest ACL:

```bash
npm run create-key -- --name browser-history --namespaces activity --permissions read,write
```

Set:

```bash
ACTIVITY_CONNECTOR_API_KEY_NAME=browser-history
# Stable HMAC secret, at least 32 bytes. Keep it unchanged or the profile source_id changes.
CONNECTOR_SOURCE_ID_KEY=<random-secret-at-least-32-bytes>
```

The profile path is HMACed into a non-secret source ID and is not stored or logged. By default each accepted event stores:

- provider visit ID scoped to that profile;
- visit time and ingestion observation time separately;
- sanitized page title;
- `http`/`https` scheme plus registrable domain only.

User info, query, fragment, path, `file:`, extension URLs, localhost, private IPs, single-label/intranet hosts, and `.local` hosts are excluded. `--full-path` is an explicit privacy opt-in; it still strips user info, query, and fragment. Titles may themselves contain sensitive text, so review a dry-run before ingesting.

## Run

Python 3 with the standard `sqlite3` module is required. No browser SQLite dependency is installed in Node. The helper opens the selected database read-only and uses SQLite's online backup API to create a consistent mode-0600 temporary snapshot, including committed WAL state. It always cleans the snapshot.

```bash
npm run browser:sync -- \
  --browser chromium \
  --profile "$HOME/.config/google-chrome/Default" \
  --dry-run

npm run browser:sync -- \
  --browser firefox \
  --profile "$HOME/.mozilla/firefox/xxxxxxxx.default-release" \
  --since 2026-01-01T00:00:00Z \
  --page-size 250 \
  --max-pages 20
```

`--database` may override the normal `History`/`places.sqlite` location. A run is bounded to `page-size × max-pages` scanned visits. If that bound is reached, committed pages retain their cursors but the command exits non-zero so an operator knows more backfill remains. Sources fail independently and any partial failure exits non-zero.

`--dry-run` reads current state and snapshots history but writes no events, memories, connector state, credentials, agents, traces, or audit rows. It does not roll activity into searchable memories; no generic activity renderer has been enabled.

## Upgrade note

Migration 035 source-scopes and enables RLS on connector credentials/state. Existing rows have no trustworthy owner and intentionally become invisible. Before restarting old media connectors, assign each legacy row to the correct key in an owner-reviewed maintenance transaction; never guess ownership. For example, after independently confirming the key name:

```sql
BEGIN;
UPDATE connector_credentials
SET client_id = (SELECT id FROM api_keys WHERE name = '<confirmed-key-name>'),
    namespace = 'media', source_id = 'default'
WHERE client_id IS NULL AND service IN ('spotify', 'ytmusic', 'plex');
UPDATE connector_sync_state
SET client_id = (SELECT id FROM api_keys WHERE name = '<confirmed-key-name>'),
    namespace = 'media', source_id = 'default'
WHERE client_id IS NULL AND service IN ('spotify', 'ytmusic', 'plex');
COMMIT;
```

Require the key subquery to identify exactly one reviewed row before executing this example. This preserves credentials without reauthorization. Existing Plex event rows are backfilled from their stored `server_id`, while other media rows use source `default`.
