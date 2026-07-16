Round-2 review written to `docs/reviews/pr-141-adversarial-round-2.md`.

## VERDICT: needs-attention

Verified against the actual tree (`db.ts`, `013/014` RLS, `server.ts`), not just the diff.

**Prior findings — all resolved or converted to documented-intentional:**

1. **Stop-the-world migration + manual ownership** — not eliminated (inherent), now fully documented (035 runbook + README + upgrade note). Remains the merge gate.
2. **Owner-only admin media visibility** — confirmed real and deliberate. Old `014:72` had `app_current_key_is_admin() OR …`; new 035 policy + `media.ts:476/521` both drop the admin branch; endpoints still admin-gated (`server.ts:835/849`) but return owner-only rows. Documented in rollout doc. **Residual action item:** confirm no HoT dashboard depends on cross-key aggregation (failure = silent lower counts).
3. **I/O inside DB transaction** — resolved. `persistAtomicPage` fetches with **no open transaction** under a session-level advisory lock + optimistic recheck; `db.ts` confirms txn-local scope commits/resets cleanly between the state-read txn and the persist txn; Plex/Base refactored the same way. Same-session re-entrancy means no self-deadlock. Test asserts `inTransaction === false` during fetch.
4. **Removed primary keys** — resolved. Surrogate `id uuid … PRIMARY KEY` added back to both tables.

**New/residual (all below block bar):**
- **[Low–Med]** The fix trades "idle-in-transaction" for "idle checked-out pool connection" held across retry backoff (pool max 10, retry up to 15s×4). Acute DB problem gone; residual pool-slot occupancy under concurrency — monitor.
- **[Low]** `browser_history_helper.py` builds a `file:C:/…` SQLite URI (non-authority form); may fail on Windows where this local tool could run. Python tests ran on POSIX. Prefer `Path.as_uri()`.

No new data-loss, auth-bypass, or correctness defect. The only blocker is operational: 035 is a scheduled, roll-forward-only cutover requiring operator sign-off and a verified manual owner-assignment step.
nly the caller's own rows.
The rollout doc explicitly states this intentional removal. **Residual action item (not a code defect):** confirm no HoT admin dashboard/report relies on cross-key media aggregation, because the failure mode is silent lower counts, not an error.

**3. Provider I/O inside the DB transaction — RESOLVED.**
Verified against `src/db.ts`: `withScopedTransactionOnClient` sets transaction-local scope and COMMITs, and transaction-local `set_config(..., true)` resets at commit, so nothing leaks between transactions.
- `persistAtomicPage` (`src/connectors/base.ts`): checks out one pooled session (`withCheckedOutClient`), takes a *session-level* advisory lock (`acquireConnectorSourceLock` → `pg_try_advisory_lock`), reads prior state in txn1 (commits), fetches the page with **no open transaction**, then persists + advances the cursor in txn2 with an optimistic recheck (`assertStateUnchanged` / `before.updated_at` vs `FOR UPDATE` row).
- `BaseConnector.run`/`backfill` and `PlexConnector.sync` moved the HTTP fetch out of the transaction under the same session lock.
- The session lock and the inner `pg_try_advisory_xact_lock` share the same key but run in the same session, so the re-entrant request succeeds (no self-deadlock, no false "already syncing").
- Test `test/connectors/source-orchestrator.test.ts` asserts `pool.inTransaction === false` inside `fetchPage`, and that persistence commits (3 COMMIT) with the failed source rolled back (1 ROLLBACK).

**4. Removed primary keys — RESOLVED.**
Migration 035 adds a surrogate `id uuid NOT NULL DEFAULT gen_random_uuid()` and `ADD CONSTRAINT ..._pkey PRIMARY KEY (id)` to both `connector_credentials` and `connector_sync_state` (plus `NULLS NOT DISTINCT` unique indexes on the natural key). `activity_events` is created with a uuid PK. Replica identity concern from round-1 is addressed.

## New / residual findings (all below the block bar)

**[Low–Medium] The session-lock fix trades "idle in transaction" for "idle checked-out connection."**
`src/connectors/base.ts` (`withConnectorSessionLock`, `persistAtomicPage`) holds one pooled connection (`getPool()` `max: 10`, `src/db.ts:25`) checked out for the *entire* fetch, including `retryConnectorOperation` backoff (`src/connectors/retry.ts`: up to 4 attempts, `maxDelayMs` 15 000 ms). The acute round-1 problem (row lock + `idle_in_transaction` abort + blocked autovacuum) is gone because no transaction is open during the fetch. What remains is pool-slot occupancy: several sources/connectors sleeping in backoff can occupy connections. Impact is materially lower than round-1's finding. Mitigation: bounded `maxPagesPerSource`, run connectors with limited concurrency, and monitor pool saturation during the post-migration bounded import.

**[Low] Windows SQLite snapshot URI form.**
`scripts/browser_history_helper.py:snapshot_database` builds `"file:" + quote(resolved_path) + "?mode=ro"`, yielding `file:C:/Users/.../History?mode=ro` on Windows — the non-authority form rather than `file:///C:/...`. Python helper tests ran on a POSIX worker. The browser connector targets an explicit local profile and could legitimately run on Windows, where this URI may fail to open. Prefer `Path(path).resolve().as_uri()` (plus the `?mode=ro` query) or verify on Windows. Low: local-only tooling, fails closed (raises, cleans snapshot).

**[Informational] media_events SELECT now also gates on namespace.**
The new policy adds `namespace = ANY(app_allowed_namespaces())`. Every `media_events` row is `namespace='media'` (CHECK constraint), so a media-scoped key is unaffected; only a key that owns media rows *without* the `media` namespace would lose read — not a realistic configuration. Noted for completeness.

## Verified as NOT defects (checked this round)
- No self-deadlock between the session advisory lock and the transaction advisory lock (same-session re-entrancy).
- No scope leakage during the out-of-transaction fetch: `withCheckedOutClient` denies namespaces by default and transaction-local scope resets at each COMMIT (`src/db.ts:129-131,157-159`).
- Chromium 64-bit microsecond cursors survive the JS boundary as decimal strings (`connector.ts` cursor `time: string`; helper `--after-time type=int`), so no precision loss.
- Cursor advances on all-filtered pages (`fetchPage` uses the last *raw* visit), so no infinite loop.
- Backfilled `event_key` cannot collide within `(client_id, service, source_id)` given the pre-migration identity uniqueness, so the synchronous unique-index builds succeed.

## House of Travel rollout impact
**Operator approval required before merge.**
- **Downtime:** stop every media/activity connector, auth command, rollup worker, and media-repair writer; take and verify a restorable backup; synchronous unique-index rebuilds on `media_events`; no pre/post-035 binary overlap.
- **Manual step:** legacy Spotify/YTMusic/Plex credentials and sync state become invisible until an operator runs the owner-assignment transaction; credentials are preserved without reauth *only if* that step is performed and verified to touch exactly the intended rows.
- **Required config:** `ACTIVITY_CONNECTOR_API_KEY_NAME`, `CONNECTOR_SOURCE_ID_KEY` (≥32 bytes, must stay stable); media connectors now hard-depend on a configured `MEDIA_CONNECTOR_API_KEY_NAMES`/`MEDIA_DEFAULT_API_KEY_NAME` with `media`+`write` (fallback `openclaw-v2`).
- **Silent behavior change:** admins lose cross-key media stats/list visibility — communicate and inventory dashboards before rollout.
- **Rollback:** roll-forward only; restoring a pre-035 binary is unsafe. Full restore from the verified backup is the only safe rollback. No vector reindex required.
