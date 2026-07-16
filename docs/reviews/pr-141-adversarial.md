## VERDICT: needs-attention — the change is functionally coherent and well-tested, but migration 035 is a stop-the-world, non-backward-compatible cutover that requires operator approval, it silently removes admin cross-key media observability, and it moves connector network/subprocess I/O inside the DB transaction. No outright data-loss/security bug found; the media re-ingest dedup path is sound (verified below).

Grounded findings, most-severe first.

---

### 1. [High — requires operator approval] Migration 035 is a hard, writers-stopped cutover that disables all existing media connectors until a manual owner-assignment step
`migrations/035_activity_connector_foundation.sql` + `docs/rollouts/035-activity-connector-foundation.md`

- **What fails:** RLS is enabled on `connector_credentials` and `connector_sync_state` with policies requiring `client_id = app_current_key_id()` (lines ~150–206), but the new `client_id` column is backfilled NULL. Every legacy credential/state row becomes invisible to the app role. The old table PKs are dropped and replaced; media-identity columns are rewritten with **synchronous** (non-`CONCURRENTLY`) unique index builds on `media_events`. The runbook itself mandates: stop every connector/auth/rollup/repair writer, take a verified backup, never overlap pre/post-035 binaries, and run a manual owner-assignment transaction.
- **Impact (HoT gate):** unavoidable maintenance window with downtime for Spotify/YTMusic/Plex ingestion; forced manual SQL to restore credential ownership; rollback of an old binary post-migration is explicitly unsafe. This is a behavior/config/rollout disruption that must not be merged without operator scheduling and sign-off.
- **Fix:** gate merge on operator approval; execute strictly per the runbook (backup → migrate → owner-assign → single compatible binary). Do not deploy opportunistically.

### 2. [Medium-High — silent regression] Admin cross-key media observability is removed with no runbook note
`migrations/035_...sql:172-173` (new `media_events_owner_namespace_select`) vs `migrations/014_metadata_rls.sql:72-73`; `src/media.ts` `getMediaStats`/`listMediaEvents`

- **What fails:** the prior RLS SELECT policy was `USING (app_current_key_is_admin() OR client_id = app_current_key_id())`. The replacement drops the admin branch: `USING (client_id = app_current_key_id() AND namespace = ANY(app_allowed_namespaces()))`. In parallel the app layer removed its admin branch (`($2::boolean OR client_id = $1)` → `client_id = $1`) in both `listMediaEvents` and `getMediaStats`.
- **Impact:** any admin key that previously aggregated media across all keys (dashboards, `/api/media/stats`, reports) now silently returns only its own rows — no error, just quietly narrowed results. This is a behavior change not mentioned in the rollout doc or README.
- **Fix:** if intentional (privacy), document it in the 035 runbook and confirm no HoT admin consumer depends on cross-key media aggregation; if not, restore an explicit `app_current_key_is_admin()` bypass in both the policy and the query builders.

### 3. [Medium — regression] External I/O now runs inside the scoped DB transaction while holding row + advisory locks
`src/connectors/base.ts` `persistAtomicPage` (fetch inside `withScopedClient` after `lockConnectorState`), refactored `BaseConnector.run`/`backfill`, and `src/connectors/plex/connector.ts` `sync` (Plex HTTP now inside `withScopedClient`)

- **What fails:** the refactor moved provider fetch *into* the open transaction. `persistAtomicPage` acquires `pg_try_advisory_xact_lock` + `SELECT … FOR UPDATE` on `connector_sync_state`, then calls `fetchConnectorPage`, which for media connectors runs HTTP with `retryConnectorOperation` (up to 4 attempts, `maxDelayMs` 15 000 ms ≈ tens of seconds of backoff sleeps) and for the browser connector spawns a Python process that performs a full SQLite online-backup of `History`/`places.sqlite`. Previously the media path fetched *before* opening the transaction.
- **Impact:** long "idle in transaction" with a row lock held; if the DB sets `idle_in_transaction_session_timeout`, a slow fetch/backoff aborts the whole page. The pool is `max: 10`; several sources/connectors sleeping in backoff can starve it. Long transactions also block autovacuum on `connector_sync_state`.
- **Fix:** fetch the page outside the transaction; open the scoped transaction only to persist events and advance the cursor (keep the advisory lock via a short-lived checkout / `withCheckedOutClient` per page, which already exists for exactly this pattern).

### 4. [Low] `connector_credentials`/`connector_sync_state` lose their primary keys
`migrations/035_...sql` — `DROP CONSTRAINT IF EXISTS connector_credentials_pkey` / `connector_sync_state_pkey`, replaced only by unique indexes

- **What fails:** the tables end with no declared primary key (only `NULLS NOT DISTINCT` unique indexes). If HoT uses logical replication or tooling that relies on a PK/replica identity, `UPDATE`/`DELETE` replication of these tables can fail or fall back to full-row identity.
- **Impact:** potential replication/tooling breakage on two small operational tables.
- **Fix:** confirm replica identity is acceptable, or add `REPLICA IDENTITY`/promote one unique index to `PRIMARY KEY` (client_id is nullable during the window, so add it after owner-assignment).

---

Verified as **not** defects (checked against the tree): re-ingested legacy rows do not duplicate — Plex `metadata.server_id === server.clientIdentifier === source_id` (`plex/transform.ts:31,46`) matches the backfill and the compatibility `media_events_source_effective_identity_uidx` under `ON CONFLICT DO NOTHING`; `app_allowed_namespaces()`/`app_current_key_id()` exist (013/014); activity ingest correctly strips caller ownership and enforces namespace + RLS; URL/host sanitization excludes private/local/file/extension targets; cursor advances on all-filtered pages so no infinite loop; `MediaUpsertResult` matches the activity response shape.

---

### House of Travel rollout impact
**Operator-visible impact identified — approval required before merge.**
- **Downtime / maintenance window:** migration 035 requires all media/activity/auth/rollup/repair writers stopped, a verified backup, synchronous index rebuilds on `media_events`, and no pre/post-035 binary overlap.
- **Manual step / no reauth-but-manual-ownership:** existing Spotify/YTMusic/Plex connector credentials and sync state become invisible until an operator runs the owner-assignment transaction (README upgrade note); credentials are preserved without user reauthentication *only if* that step is performed.
- **Required config:** `ACTIVITY_CONNECTOR_API_KEY_NAME` and `CONNECTOR_SOURCE_ID_KEY` (≥32 bytes, must stay stable) for the browser connector; media connectors now hard-depend on a valid configured media key (`MEDIA_CONNECTOR_API_KEY_NAMES`/`MEDIA_DEFAULT_API_KEY_NAME`) with `media`+`write`.
- **Silent behavior change:** admins lose cross-key media stats/list visibility (Finding 2) — communicate before rollout.
- **Rollback:** roll-forward only; restoring a pre-035 binary is unsafe. Full DB restore from the verified backup is the sole safe rollback. No vector reindex required.
- **Mitigation:** schedule the window, follow the 035 runbook exactly, verify the owner-assignment transaction affects exactly the intended rows, and address Finding 3 (I/O-in-transaction) to avoid `idle_in_transaction` aborts during the post-migration bounded import.
