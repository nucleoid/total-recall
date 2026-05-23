# Spotify Connector

Pulls your recently-played tracks from Spotify into `media_events`, rolls them up into embedded summary memories in the `media` namespace, and makes them searchable via `media_search`.

## Limitations

- Spotify only exposes the **last 50 played tracks** via the Web API. There's no deeper history endpoint.
- Skipped tracks are not reported as a distinct event type — Spotify only logs completed plays in `recently-played`.
- Podcast episodes are returned by the same endpoint but are not yet specially handled.

For a one-time backfill of years of history, request a "Stream history" from Spotify under Account → Privacy (delivered in ~30 days). A separate importer for that JSON dump is a future option.

## Setup

### 1. Create a Spotify developer app

1. Go to <https://developer.spotify.com/dashboard>
2. Click **Create app**
3. Settings:
   - **Redirect URIs**: `http://localhost:8888/callback`
   - **Which API/SDKs are you planning to use?**: Web API
4. Save and copy the **Client ID** and **Client secret**

### 2. Set env vars

Add these to your environment (e.g. systemd unit, `.env`, or shell profile):

```bash
export SPOTIFY_CLIENT_ID=your-client-id
export SPOTIFY_CLIENT_SECRET=your-client-secret
# Optional overrides:
# export SPOTIFY_REDIRECT_URI=http://localhost:8888/callback
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
- `metadata` with track ID, ISRC, popularity, album art URL, context (playlist/album/etc.)

The rollup writes a summary memory like:

> Listened to "Motion Sickness" by Phoebe Bridgers from "Stranger in the Alps" on 2026-05-20 via spotify.

These are embedded and searchable via `media_search` or any other consumer of the `media` namespace.

## Troubleshooting

**"No Spotify credentials stored"** — Run `npm run spotify:auth` first.

**401 from Spotify on sync** — Refresh token revoked. Re-run `npm run spotify:auth`.

**"Invalid redirect URI"** — The URI in the env (`SPOTIFY_REDIRECT_URI`) must exactly match one registered in your Spotify dev app.

**Cron not picking up new plays** — Check `last_event_at` in `connector_sync_state`. If it's wrong (e.g. stuck in the future), `UPDATE connector_sync_state SET last_event_at = NULL WHERE service = 'spotify'` and re-run.
