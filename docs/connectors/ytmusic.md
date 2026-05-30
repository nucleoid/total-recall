# YouTube Music Connector

Pulls your YouTube Music play history into `media_events` and rolls it up into embedded summary memories. Uses the unofficial [`ytmusicapi`](https://ytmusicapi.readthedocs.io) Python library because Google has never exposed an official "recently played" endpoint for YouTube Music.

## Caveats

- **Unofficial API** — `ytmusicapi` reverse-engineers YouTube Music's internal API. It can break when Google changes things. The library is well-maintained, but expect occasional churn.
- **History depth** — `get_history()` returns whatever YouTube remembers (typically last few hundred plays). For deeper backfill, use a Google Takeout export of "YouTube and YouTube Music" data — not yet automated.
- **Premium not required** — a regular YouTube Music account works; Premium just gives ad-free playback.
- **Account separation** — log into the Google account that has your YouTube Music history. If you use a brand account, make sure it's a personal one (brand accounts can be flaky).

## One-time setup

### 1. Install ytmusicapi on the host

Modern Debian/Ubuntu enforce [PEP 668](https://peps.python.org/pep-0668/) and reject system-wide `pip install`. Use a project-local venv:

```bash
cd /home/fuego/projects/total-recall
python3 -m venv .venv
.venv/bin/pip install ytmusicapi
```

Then set `YTMUSIC_PYTHON` to the venv's interpreter (see step 3). On older systems where `pip install --user ytmusicapi` works, you can skip the venv and leave `YTMUSIC_PYTHON` unset.

### 2. Create a Google Cloud OAuth client

YouTube's device-code flow requires an OAuth client of type **TVs and Limited Input devices**. Standard "Web" or "Desktop" clients won't work for this.

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → search for **YouTube Data API v3** → **Enable**.
3. **APIs & Services → OAuth consent screen** — configure as "External", add yourself as a Test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
5. Application type: **TVs and Limited Input devices**. Give it any name.
6. Copy the **Client ID** and **Client Secret**.

### 3. Set env vars

In `/home/fuego/projects/total-recall/.env`:

```bash
YTMUSIC_CLIENT_ID=your-google-client-id
YTMUSIC_CLIENT_SECRET=your-google-client-secret
# Path to the python3 with ytmusicapi installed (the venv from step 1).
YTMUSIC_PYTHON=/home/fuego/projects/total-recall/.venv/bin/python3
```

### 4. Run the auth flow

```bash
cd /home/fuego/projects/total-recall
npm run ytmusic:auth
```

You'll see something like:

```
Please go to https://www.google.com/device
and enter code XXX-XXX-XXX
```

Open that URL **on any device** (laptop, phone), sign in with the Google account that has your YouTube Music, paste the code, and approve. The script blocks until you finish, then stores the refresh token in `connector_credentials`.

Headless boxes are fine — there's no callback URL or local web server involved.

### 5. First sync

```bash
npm run ytmusic:sync
```

Expected output:
```
[ytmusic-sync] 47 ingested, 0 skipped, 1140ms
[ytmusic-sync] rollup: 47 memories, 0 failed
```

### 6. Schedule

Recommended: hourly. YouTube only retains a finite history window, but you only need to pull whatever's new since last_event_at.

```cron
0 * * * * cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/ytmusic-sync.js >> /tmp/ytmusic-sync.log 2>&1
```

## What gets stored

Each play becomes one `media_events` row with:

- `service = 'ytmusic'`
- `service_id = videoId` (deduplicates re-plays of the same track on the same timestamp)
- `event_type = 'play'`
- `title`, `artist` (joined from `artists[]`), `album`, `duration_ms`, `played_at`
- `metadata` with `video_id`, watch URL, thumbnail, like status, etc.

Each event rolls up to a summary memory like:

> Listened to "Punisher" by Phoebe Bridgers from "Punisher" on 2026-05-22 via ytmusic.

## Troubleshooting

**`ytmusicapi not installed`** — `pip install --user ytmusicapi` (matching the python3 in your PATH or `YTMUSIC_PYTHON`).

**`Device-code authorization expired`** — you took too long to enter the code. Just re-run `npm run ytmusic:auth`.

**`invalid_client` or `unauthorized_client`** — the OAuth client type is wrong. It must be "TVs and Limited Input devices", not Web or Desktop.

**History is empty** — make sure you're signed into the right Google account. If you use multiple Google accounts, the brand account distinction matters — pick the personal one that actually owns the YouTube Music history.

**Token revoked / 401 errors** — re-run `npm run ytmusic:auth`. Google may revoke OAuth tokens if the consent screen is in "Testing" mode after 7 days; promoting it to "Production" extends this.

**Cron has no PATH for python3** — set `YTMUSIC_PYTHON=/usr/bin/python3` in `.env`.
