# Migration 035 activity connector foundation rollout

Migration 035 replaces media identity with owner/service/source/event identity, adds the separate `activity_events` domain, and enables owner-plus-namespace RLS for connector credentials and state. This intentionally removes the previous admin cross-key bypass for media event lists and statistics: an admin key now sees only media rows it owns. Inventory any dashboard/report that relied on cross-key media aggregation and move it to explicitly owner-scoped credentials before rollout.

## Before migration

1. Stop every media/activity connector, auth command, rollup worker, and media repair writer. Old and new binaries must not overlap.
2. Take and verify a restorable database backup.
3. Inventory duplicate candidate groups under `(client_id, service, source_id, event_key)` and confirm Plex rows have trustworthy `metadata.server_id`. Do not delete ambiguous rows.
4. Inventory each `connector_credentials` and `connector_sync_state` row and independently map it to one API key. The migration intentionally does not guess that ownership.
5. Confirm the selected keys include `media` or `activity` and the required read/write permissions.
6. Inventory admin dashboards/reports for cross-key media list/statistics use. The privacy correction to owner-only results is intentional and otherwise appears as silently lower counts.

## Deploy

1. Apply migration 035 with the schema owner. It rewrites media source/event-key columns and synchronously builds unique indexes, so size the maintenance window for `media_events`.
2. In an owner-reviewed transaction, assign each legacy null-owner credential/state row to its confirmed key as shown in the [browser connector upgrade note](../connectors/browser-history.md#upgrade-note).
3. Deploy one compatible binary to every connector/auth/REST/rollup process.
4. Run `npm run browser:sync -- ... --dry-run`; verify sanitized rows, stable source ID, event count, and unchanged database row counts.
5. Run a small bounded import, inspect `activity_events`, and only then schedule it. Activity rollup is intentionally unavailable.
6. Resume existing media connectors one at a time and verify source-scoped event identity and cursor movement.

A source failure leaves its page uncommitted while independent successful sources retain their event/cursor transaction. Page-cap or partial failures exit non-zero.

## Rollback

Prefer roll-forward. The schema and source IDs remain useful if the browser schedule is disabled. Restoring an old connector binary after migration is unsafe because old credential/state conflict targets and media identity are gone. If database rollback is unavoidable, stop all writers and restore the verified pre-migration backup; do not manually drop only the new indexes or RLS policies. No vector reindex is required.
