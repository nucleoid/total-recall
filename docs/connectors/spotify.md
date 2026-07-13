# Spotify Connector

Pulls your recently-played tracks from Spotify into `media_events`, rolls them up into embedded summary memories in the `media` namespace, and makes them searchable via `media_search`.

## Limitations

- Spotify only exposes the **last 50 played tracks** via the Web API. There's no deeper history endpoint.
- Spotify's `recently-played` endpoint confirms that a play event occurred, but does not report playback progress or completion. `played_ms` and `completed` are therefore stored as unknown (`NULL`), while `duration_ms` retains the track duration.
- Podcast episodes are returned by the same endpoint but are not yet specially handled.

For a one-time backfill of years of history, request a "Stream history" from Spotify under Account → Privacy (delivered in ~30 days). A separate importer for that JSON dump is a future option.

## Setup

### 1. Create a Spotify developer app

1. Go to <https://developer.spotify.com/dashboard>
2. Click **Create app**
3. Settings:
   - **Redirect URIs**: `http://127.0.0.1:8888/callback`
     (Spotify rejects the `localhost` hostname; use the loopback IP instead.)
   - **Which API/SDKs are you planning to use?**: tick **Web API** (not Web Playback SDK — different product)
4. Save and copy the **Client ID** and **Client secret**

### 2. Set env vars

Add these to your environment (e.g. systemd unit, `.env`, or shell profile):

```bash
export SPOTIFY_CLIENT_ID=your-client-id
export SPOTIFY_CLIENT_SECRET=your-client-secret
# Optional overrides (defaults shown):
# export SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
# export SPOTIFY_AUTH_PORT=8888
```

### 3. Run the one-time auth flow

```bash
cd /path/to/total-recall
npm run spotify:auth
```

The script opens a browser, you log in, grant the requested scopes, and it captures the redirect — exchanging the code for an access + refresh token and storing them in the `connector_credentials` table. No further user interaction needed after this.

### 4. Verify the first sync

```bash
npm run spotify:sync
```

You should see something like:

```
[spotify-sync] 12 ingested, 0 skipped, 743ms
[spotify-sync] rollup: 12 memories, 0 failed
```

### 5. Schedule the cron

Recommended: every 30 minutes. Spotify returns at most the last 50 tracks, so don't go longer than a few hours between syncs.

```cron
*/30 * * * * cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/spotify-sync.js >> /tmp/spotify-sync.log 2>&1
```

(Or use `npm run spotify:sync` if you prefer tsx-based execution; node + built `.js` is faster.)

## What gets stored

Each play becomes one row in `media_events` with:

- `service = 'spotify'`
- `service_id = 'spotify:track:...'` (the track URI, ensuring deduplication)
- `event_type = 'play'`
- `title`, `artist`, `album`, `year`, `duration_ms`, `played_at`
- nullable `played_ms` and `completed`, both left `NULL` because progress is unknown
- `metadata` with track ID, ISRC, popularity, album art URL, context (playlist/album/etc.)

## Historical progress repair

Older connector versions fabricated a full listen for every recently-played item. Historical rows cannot be repaired automatically: the database has no ingestion provenance, and an identical row could have been supplied through the REST API with measured progress.

The repair command is preview-only by default:

```bash
npm run spotify:repair-progress -- --max-rows 500
```

Stop Spotify sync before previewing. Preview prints bounded candidate IDs, the complete candidate count, and current-state fingerprints without writing. Time filters (`--played-after` and `--played-before`) may narrow preview only; they never authorize updates.

Applying is a separate, explicitly authorized operation. First take and verify a restorable backup, independently prove each event ID came from the affected Spotify connector, and copy only those exact preview records (`id`, `clientId`, and `fingerprint`) into a JSON approval manifest. Then run:

```bash
npm run spotify:repair-progress -- --apply --confirm-backup --approval-manifest ./approved-spotify-events.json
```

A predicate, count, date range, or general approval of the repair is not authorization. Missing, duplicate, nonmatching, or drifted IDs are rejected. Ambiguous or unverified candidates remain unchanged. Apply nulls only the approved event's progress fields and, when the still-linked rollup is `source='media:spotify'`, removes its `played_ms`/`completed` metadata keys and exact `completed` tag. It preserves content, embedding, duration, unrelated metadata/tags, IDs, and links; no re-embedding occurs. Consequently, a rare legacy artist-less Spotify rollup that fell back to completion wording in its summary may retain that historical text even after its structured progress is nulled. A non-zero partial failure reports a resumable checkpoint. Inspect outcomes before resuming Spotify sync.

The rollup writes a summary memory like:

> Listened to "Motion Sickness" by Phoebe Bridgers from "Stranger in the Alps" on 2026-05-20 via spotify.

These are embedded and searchable via `media_search` or any other consumer of the `media` namespace. Every rollup has one exclusive media-kind tag. Spotify `play` events are tagged `music` even if artist metadata is missing; events without trusted service or canonical field evidence use `unknown` rather than defaulting to `movie`.

The summary's calendar date uses the optional `MEDIA_TIME_ZONE` IANA zone (for example, `America/Chicago`) and defaults explicitly to `UTC`; it never inherits the host `TZ`. Use the same setting for every rollup worker. The structured `played_at` instant remains unchanged. Existing summaries require the dry-run-by-default `npm run media:repair-dates` command if you choose to repair them.

## Troubleshooting

**"No Spotify credentials stored"** — Run `npm run spotify:auth` first.

**401 from Spotify on sync** — Refresh token revoked. Re-run `npm run spotify:auth`.

**"Invalid redirect URI"** — The URI in the env (`SPOTIFY_REDIRECT_URI`) must exactly match one registered in your Spotify dev app. Note Spotify (as of April 2025) rejects the `localhost` hostname for redirect URIs — use `127.0.0.1` or `[::1]` instead.

**Cron not picking up new plays** — Check `last_event_at` in `connector_sync_state`. If it's wrong (e.g. stuck in the future), `UPDATE connector_sync_state SET last_event_at = NULL WHERE service = 'spotify'` and re-run.
