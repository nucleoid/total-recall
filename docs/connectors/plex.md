# Plex Connector

Pulls your Plex watch history into `media_events` and rolls each entry up into an embedded summary memory. Works for **your own server, friends' shared servers, or any server you're signed into via your plex.tv account**; discovery happens through the central plex.tv resource directory.

## How it works

1. PIN-based OAuth flow via plex.tv. There is no client ID/secret to configure; we generate a stable `X-Plex-Client-Identifier` once and persist it.
2. `GET https://plex.tv/api/v2/user` once to capture your account `id` and `uuid`.
3. `GET https://plex.tv/api/v2/resources` lists every server you can reach, owned and shared.
4. For each server, pick the first reachable connection (local LAN, public direct, then plex.direct relay) and call `/status/sessions/history?accountID={expected}&viewedAt>={since}`. If that endpoint is unavailable with 401/404, retry `/status/sessions/history/all` with the same query.
5. Choose `accountID` per server: owned servers use Plex Media Server's local owner id `1`; shared servers use your plex.tv account id. Returned rows are normalized and filtered against the same expected id before ingest.
6. Track progress per server in `connector_sync_state.metadata.plex.server_cursors`, keyed by Plex resource `clientIdentifier`. The legacy `last_event_at` value is left unchanged for observation/rollback and is not used as a Plex lower bound.

Cursor metadata shape:

```json
{
  "plex": {
    "cursor_version": 1,
    "server_cursors": {
      "server-client-identifier": "2026-05-21T12:34:56.000Z"
    }
  }
}
```

## Caveats

- **Per-server history depth** depends on each server's retention settings. Plex defaults to keeping history forever, but the server owner can wipe it.
- **No webhooks for friends' servers**: Plex webhooks only fire to the owner's configured endpoint, so we poll. 30 minutes is a good cadence.
- **Friend-server reachability** uses Plex's `plex.direct` relay when direct connections are not available. Slower but works through NAT.
- **service_id includes server identifier** (`{serverClientId}:{ratingKey}`) so the same ratingKey on two different servers does not collide.
- **First upgraded sync replays retained history per server** if no per-server cursor exists, even when an old global `last_event_at` is present. Duplicate events are skipped by the existing uniqueness key, and conflict-only successful scans still advance that server's cursor.
- **Network fetch failures are isolated per server.** Servers that complete successfully commit their events and cursor updates together in one DB transaction. Failed fetches keep their previous cursor and are retried from that point. A database insert, state-write, or commit failure rolls back the entire successful-server batch so events and cursors cannot diverge.
- **Account-filtered scans still advance safely.** After every page is completely scanned, the cursor advances to the newest validated row even if all rows belonged to another Plex account. Those rows are not ingested, but recording the scanned high-water prevents an unbounded replay on every scheduled run.

## Upgrade rollout runbook

The first per-server-cursor run is an intentional retained-history replay. Treat it as a monitored maintenance operation rather than allowing a scheduler to discover the new version.

1. **Stop every Plex scheduler and manual sync job.** Confirm no old process is still running. Never overlap a global-cursor deployment with this per-server-cursor deployment.
2. **Back up `connector_sync_state` and `media_events`.** Deploy the same new version everywhere while Plex remains stopped.
3. Record the pre-run state and expected resource identifiers:

   ```sql
   SELECT last_event_at, metadata
   FROM connector_sync_state
   WHERE service = 'plex';
   ```

   `clientIdentifier` values printed by `npm run plex:auth` are the expected keys in `metadata.plex.server_cursors`.
4. Run exactly one monitored replay: `npm run plex:sync`. Watch Plex/API, database, and embedding/rollup load. Do not start an automatic retry while this process is active.
5. Verify the result before enabling scheduling:

   ```sql
   SELECT
     last_event_at AS unchanged_legacy_cursor,
     metadata->'plex'->>'cursor_version' AS cursor_version,
     metadata->'plex'->'server_cursors' AS server_cursors
   FROM connector_sync_state
   WHERE service = 'plex';

   SELECT metadata->>'server_id' AS server_id, count(*) AS event_count,
          min(played_at) AS oldest_event, max(played_at) AS newest_event
   FROM media_events
   WHERE service = 'plex'
   GROUP BY metadata->>'server_id'
   ORDER BY server_id;
   ```

   Confirm `cursor_version` is `1`, every successful discovered server has its own `clientIdentifier` key, each cursor matches that server's newest completely scanned history row, and the legacy `last_event_at` is unchanged. A failed server must retain its previous cursor (or remain absent on its first run).
6. Resolve or explicitly accept any degraded server, then resume **exactly one** scheduler on the new version.

The command emits a final machine-readable line: `completed status=ok|degraded|failed exit_code=0|1`. Alert on every nonzero exit, but suppress overlapping automatic retries; successful-server events and cursors may already have committed and rolled up. Investigate the contextual server errors and let the next scheduled run retry failed servers from their unchanged cursors.

Rollback does not remove replayed events or per-server metadata, but old code ignores that metadata and resumes using the unchanged unsafe global cursor. Keep Plex scheduling stopped during rollback and do not resume an old scheduler as a recovery mechanism.

## Setup

### 1. Run the PIN flow

```bash
cd /home/fuego/projects/total-recall
npm run plex:auth
```

The script prints something like:

```
Link:  https://plex.tv/link
Code:  ABCD

Waiting for authorization...
```

Open the link **on any device** (laptop, phone), sign in if needed, enter the code, approve. The script polls and unblocks when you have authorized, then prints the list of servers discovered.

### 2. First sync

```bash
npm run plex:sync
```

Expected output:

```
[plex-sync] 142 ingested, 0 skipped, 2310ms
[plex-sync] rollup: 142 memories, 0 failed
```

If one server is offline but another server succeeds, the sync still rolls up inserted events, prints the failed server context, awaits DB cleanup, and exits nonzero so cron/monitoring can alert on the degraded run.

### 3. Schedule

Recommended: every 30 minutes.

```cron
*/30 * * * * cd /home/fuego/projects/total-recall && /home/fuego/projects/total-recall/node_modules/.bin/tsx scripts/plex-sync.ts >> /tmp/plex-sync.log 2>&1
```

## What gets stored

Each watch becomes one `media_events` row with:

- `service = 'plex'`
- `service_id = '{serverClientId}:{ratingKey}'`
- `event_type = 'watch'` for movies/episodes, `'play'` for music
- `title`, `show` (grandparentTitle), `season`, `episode`, `year`, `duration_ms`, `played_at` (from viewedAt)
- `metadata` with rating_key, server name and id, library section, thumbnails

Rolled-up memories read like:

> Watched Severance S02E03 "The Doll" on 2026-05-21 via plex. Completed.

Every rollup has one exclusive media-kind tag: Plex `metadata.plex_type` maps `track` to `music`, `episode` to `tv`, and `movie` to `movie`. Canonical artist/show/episode fields are used when that trusted type is absent; otherwise the kind is `unknown` rather than assuming a generic watch is a movie.

The summary's calendar date uses the optional `MEDIA_TIME_ZONE` IANA zone (for example, `America/Chicago`) and defaults explicitly to `UTC`; it never inherits the host `TZ`. Use the same setting for every rollup worker. The structured `played_at` instant remains unchanged. Existing summaries require the dry-run-by-default `npm run media:repair-dates` command if you choose to repair them.

## Troubleshooting

**`No Plex credentials. Run scripts/plex-auth.ts first.`** - exactly what it says. Run `npm run plex:auth`.

**`Plex PIN expired without being claimed.`** - PIN expiry is controlled by Plex. The PIN may have reached its server-provided deadline before it was approved; just re-run `npm run plex:auth`.

**`Plex PIN expired or was deleted.`** - Plex no longer recognizes the PIN. Re-run `npm run plex:auth`; the connector stops polling deleted PINs immediately.

**`No accessible Plex servers found for this account.`** - check that your plex.tv account is actually linked to at least one server (yours or a friend's). Try logging into app.plex.tv to confirm.

**`no reachable connection for server "X"`** - that server is offline or its public endpoint is not reachable from fuego. If it is a friend's server, ask them to bring it online. If it is intermittent, the connector reports a degraded run and retries that server from its unchanged per-server cursor on the next sync.

**`history fetch failed: 401`** - token revoked. Re-run `npm run plex:auth`.

**Stuck at the same `last_event_at` despite watching new things** - Plex no longer advances the global `last_event_at`; inspect `metadata.plex.server_cursors` instead. If a specific server cursor is stuck, the server owner may have disabled history tracking, or your account has multiple users on the same server and the wrong one is mapped. Owned servers should request local `accountID=1`; shared servers should request your plex.tv account id from `/api/v2/user`.

**Malformed cursor metadata warning** - unsupported versions or invalid timestamps are ignored for safety. The affected server replays retained history from an unbounded lower bound and then writes a valid version 1 cursor after a complete successful scan. Self-healing metadata warnings are logged but do not make an otherwise healthy command exit nonzero.

**`invalid viewedAt`, `future viewedAt`, or pagination page-cap error** - complete-scan integrity could not be proven. The entire affected server is treated as failed: its events from this attempt are discarded and its cursor is not advanced, while other successful servers still commit. Do not configure an immediate automatic retry, because the same retained row or oversized response will fail again. Leave that server's scheduling paused, correct its data/clock or investigate its pagination response, and then retry. Skipping the bad row and advancing past it is intentionally forbidden because a corrected history row could otherwise be missed permanently.
