# Plex Connector

Pulls your Plex watch history into `media_events` and rolls each entry up into an embedded summary memory. Works for **your own server, friends' shared servers, or any server you're signed into via your plex.tv account** — discovery happens through the central plex.tv resource directory.

## How it works

1. PIN-based OAuth flow via plex.tv (no client ID/secret to configure — we generate a stable `X-Plex-Client-Identifier` once and persist it).
2. `GET https://plex.tv/api/v2/user` once to capture your account `id` + `uuid`.
3. `GET https://plex.tv/api/v2/resources` lists every server you can reach (owned + shared).
4. For each server, pick the first reachable connection (local LAN → public direct → plex.direct relay) and call `/status/sessions/history?accountID={expected}&viewedAt>={since}`. If that endpoint is unavailable with 401/404, retry `/status/sessions/history/all` with the same query.
5. Choose `accountID` per server: owned servers use Plex Media Server's local owner id `1`; shared servers use your plex.tv account id. Returned rows are normalized and filtered against the same expected id before ingest.

## Caveats

- **Per-server history depth** depends on each server's retention settings. Plex defaults to keeping history forever, but the server owner can wipe it.
- **No webhooks for friends' servers** — Plex webhooks only fire to the owner's configured endpoint, so we poll. 30 minutes is a good cadence.
- **Friend-server reachability** uses Plex's `plex.direct` relay when direct connections aren't available. Slower but works through NAT.
- **service_id includes server identifier** (`{serverClientId}:{ratingKey}`) so the same ratingKey on two different servers doesn't collide.

## Setup

### 1. Run the PIN flow

```bash
cd /home/fuego/projects/total-recall
npm run plex:auth
```

The script prints something like:

```
Link:  https://plex.tv/link?code=ABCD
Code:  ABCD

Waiting for authorization (PIN expires in 25 minutes)...
```

Open the link **on any device** (laptop, phone), sign in if needed, enter the code, approve. The script polls and unblocks when you've authorized — then prints the list of servers discovered.

### 2. First sync

```bash
npm run plex:sync
```

Expected output:

```
[plex-sync] 142 ingested, 0 skipped, 2310ms
[plex-sync] rollup: 142 memories, 0 failed
```

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
- `metadata` with rating_key, server name + id, library section, thumbnails

Rolled-up memories read like:

> Watched Severance S02E03 "The Doll" on 2026-05-21 via plex. Completed.

## Troubleshooting

**`No Plex credentials. Run scripts/plex-auth.ts first.`** — exactly what it says. Run `npm run plex:auth`.

**`Plex PIN expired without being claimed.`** — you took longer than 25 min. Just re-run `npm run plex:auth`.

**`No accessible Plex servers found for this account.`** — check that your plex.tv account is actually linked to at least one server (yours or a friend's). Try logging into app.plex.tv to confirm.

**`no reachable connection for server "X"`** — that server is offline or its public endpoint isn't reachable from fuego. If it's a friend's server, ask them to bring it online. If it's intermittent, the connector will silently skip until the next sync.

**`history fetch failed: 401`** — token revoked. Re-run `npm run plex:auth`.

**Stuck at the same `last_event_at` despite watching new things** — the server owner may have disabled history tracking, or your account has multiple users on the same server and the wrong one is mapped. Owned servers should request local `accountID=1`; shared servers should request your plex.tv account id from `/api/v2/user`.
