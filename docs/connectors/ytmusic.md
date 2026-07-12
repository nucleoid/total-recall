# YouTube Music Connector

Pulls your YouTube Music play history into `media_events` and rolls it up into embedded summary memories. Uses the unofficial [`ytmusicapi`](https://ytmusicapi.readthedocs.io) Python library because Google has never exposed an official "recently played" endpoint for YouTube Music.

## Caveats

- **Unofficial API** — `ytmusicapi` reverse-engineers YouTube Music's internal API. It can break when Google changes things. The library is well-maintained, but expect occasional churn.
- **History depth** — `get_history()` returns whatever YouTube remembers (typically last few hundred plays). For deeper backfill, use a Google Takeout export of "YouTube and YouTube Music" data — not yet automated.
- **Premium not required** — a regular YouTube Music account works; Premium just gives ad-free playback.
- **Account separation** — log into the Google account that has your YouTube Music history. If you use a brand account, make sure it's a personal one (brand accounts can be flaky).
- **OAuth currently broken for YT Music** — Google rejects device-code OAuth clients on YouTube Music's backend with HTTP 400 ("invalid argument") for browse/library/history endpoints. As of writing, **only browser-headers auth reliably works**. Use the browser flow below; the OAuth flow is retained in case Google fixes it.

## One-time setup (browser headers — recommended)

### 1. Install ytmusicapi on the host

Modern Debian/Ubuntu enforce [PEP 668](https://peps.python.org/pep-0668/) and reject system-wide `pip install`. Use a project-local venv:

```bash
cd /home/fuego/projects/total-recall
python3 -m venv .venv
.venv/bin/pip install ytmusicapi
```

Then set `YTMUSIC_PYTHON` to the venv's interpreter (see step 3). On older systems where `pip install --user ytmusicapi` works, you can skip the venv and leave `YTMUSIC_PYTHON` unset.

### 2. Set the Python path env var

In `/home/fuego/projects/total-recall/.env`:

```bash
YTMUSIC_PYTHON=/home/fuego/projects/total-recall/.venv/bin/python3
```

### 3. Capture browser request headers

1. Open <https://music.youtube.com> in a regular browser, signed into the Google account whose history you want.
2. Open **DevTools** (F12) → **Network** tab. Make sure recording is on.
3. Refresh the page or navigate around so requests appear.
4. In the request list, click any request whose path contains `/youtubei/v1/browse` (you can filter by typing `browse` in the filter box).
5. In the request details panel:
   - **Chrome/Edge**: Right-click the request → **Copy** → **Copy request headers**.
   - **Firefox**: open the **Headers** tab in the right panel, right-click anywhere in the "Request Headers" section → **Copy Request Headers**.
6. You should now have many lines like `Cookie: ...`, `Authorization: SAPISIDHASH ...`, `X-Goog-AuthUser: 0`, etc. in your clipboard.

### 4. Run the auth flow

On fuego:

```bash
cd /home/fuego/projects/total-recall
npm run ytmusic:auth-browser
```

The script waits for you to paste the headers on stdin. Paste them, then press **Ctrl+D** (Linux/macOS) to signal end-of-input. The script saves the extracted config to `connector_credentials`.

You can also pipe headers in directly if you've saved them to a file:

```bash
npm run ytmusic:auth-browser < /path/to/headers.txt
```

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

Recommended: hourly. YouTube only retains a finite history window, so each sync refetches the full `get_history()` window and lets database conflicts skip rows already stored.

```cron
0 * * * * cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/ytmusic-sync.js >> /tmp/ytmusic-sync.log 2>&1
```

## Alternative: OAuth setup (currently broken)

The OAuth device-code flow returns HTTP 400 from YouTube Music for browse / library / history calls as of early 2026. The code is retained in case Google fixes it. If you want to try anyway:

1. Create a Google Cloud project, enable **YouTube Data API v3**.
2. **Credentials → Create OAuth client ID** → type **TVs and Limited Input devices**.
3. Add to `.env`:
   ```bash
   YTMUSIC_CLIENT_ID=...
   YTMUSIC_CLIENT_SECRET=...
   ```
4. Run `npm run ytmusic:auth`, complete the device-code prompt.
5. Run `npm run ytmusic:sync` — currently fails with `Server returned HTTP 400`. If your run succeeds, please open an issue.

## What gets stored

Each play becomes one `media_events` row with:

- `service = 'ytmusic'`
- `service_id = videoId` (deduplicates re-plays of the same track on the same timestamp)
- `event_type = 'play'`
- `title`, `artist` (joined from `artists[]`), `album`, `duration_ms`, `played_at`
- `metadata` with `video_id`, watch URL, thumbnail, like status, etc.

YouTube Music often returns history positions as labels rather than exact
instants. The connector accepts exact offset-aware ISO timestamps and these
English bucket labels:

- `Today` and `just now` -> 12:00 UTC on the current UTC date.
- `Yesterday` -> 12:00 UTC on the previous UTC date.
- `N minutes ago` and `N hours ago` -> the minute or hour boundary after
  subtracting the offset from the sync time.
- `N days ago` -> 12:00 UTC on the target UTC date.
- `N weeks ago`, `last week`, and `a week ago` -> Wednesday 12:00 UTC of the
  target Monday-based week.
- `N months ago`, `last month`, and `a month ago` -> day 15 12:00 UTC of the
  target calendar month.
- `N years ago`, `last year`, and `a year ago` -> July 2 12:00 UTC of the
  target calendar year.
- `This week` -> Wednesday 12:00 UTC of the current Monday-based week.
- `This month` -> day 15 12:00 UTC of the current month.
- Full English month names and standard three-letter abbreviations -> day 15
  12:00 UTC of the most recent occurrence whose month has begun.
- A bare four-digit year -> July 2 12:00 UTC of that year.

These timestamps are deterministic UTC representatives, not exact play times.
The helper preserves the original label as `played_raw` and records
`played_precision`, `played_bucket`, and `played_cursor_eligible` in event
metadata so downstream users can audit the approximation and the sync cursor
does not advance from future-dated representatives.

Sync intentionally does not pass `--since` to the Python helper and does not
advance the generic `last_event_at` high-water mark. A new item in an
already-seen bucket such as `Today` or `This week` remains eligible for
ingestion even when its representative timestamp is equal to rows from a
previous sync. This favors completeness over using coarse timestamps as an
exclusive cursor.

Label aging can still create approximate duplicates. For example, a play first
seen as `Today` maps to that day at noon and maps to the same instant if it is
seen as `Yesterday` the next day, but a later transition to `This week` or
`This month` may map to a different bucket representative. The connector keeps
the raw label and precision metadata so downstream dedupe policy can make that
tradeoff explicitly.

Unsupported localized or malformed labels are not guessed. The helper emits a
structured `unparsable played bucket` diagnostic for the item and skips only
that row.

Each event rolls up to a summary memory like:

> Listened to "Punisher" by Phoebe Bridgers from "Punisher" on 2026-05-22 via ytmusic.

Every rollup has one exclusive media-kind tag. YouTube Music `play` events are tagged `music` even if artist metadata is missing; events without trusted service or canonical field evidence use `unknown` rather than defaulting to `movie`.

## Troubleshooting

**`ytmusicapi not installed`** — install into the venv and set `YTMUSIC_PYTHON` to its python3 binary.

**`Server returned HTTP 400: Bad Request. Request contains an invalid argument.`** — you're using OAuth auth. Switch to browser-headers (`npm run ytmusic:auth-browser`).

**`no headers supplied on stdin`** — you ran `ytmusic:auth-browser` but didn't paste headers, or didn't press Ctrl+D. Try again, paste, press Ctrl+D.

**`Cookie` header is missing or auth seems weak** — make sure you copied the request headers, not the response headers. Look for `Cookie:`, `Authorization: SAPISIDHASH`, `X-Goog-AuthUser`, and similar.

**History is empty** — confirm you're capturing headers from the right browser profile / Google account. Multiple-account quirks bite here.

**Headers stop working after a while** — YouTube Music sessions roll over occasionally (every few weeks typically). Re-capture and re-run `npm run ytmusic:auth-browser`.

**Cron has no PATH for python3** — keep `YTMUSIC_PYTHON` set to the absolute venv path in `.env`.

**Recovering from prior cursor misses** — run another normal sync. The connector now refetches the retained history window, so tracks that are still present in YouTube Music history can be picked up without resetting credentials or editing sync state.
