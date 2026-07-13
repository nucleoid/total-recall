# Migration 021 media event identity rollout

Migration `021_tenant_media_event_identity.sql` changes media-event idempotency from the old global `(service, service_id, played_at)` key to the tenant-local `(client_id, service, service_id, played_at)` key.

This is the approved rollout sequence:

1. Stop all REST and connector media writers.
2. Apply migration 021 and allow its `media_events` DDL lock while PostgreSQL drops the old uniqueness constraint and builds the new unique constraint/index.
3. Deploy only the new writer binary that uses `ON CONFLICT (client_id, service, service_id, played_at) DO NOTHING`.
4. Verify the new writer is active.
5. Resume media writers.

Do not run old and new media writer binaries concurrently across this migration. Old binaries still target `ON CONFLICT (service, service_id, played_at) DO NOTHING` and can error once the old uniqueness constraint has been dropped.

Size the maintenance window against the current `media_events` row count because `ADD CONSTRAINT UNIQUE` builds synchronously under the migration runner's transaction. Media writers must remain stopped until the new binary is deployed and verified.

Do not weaken the tenant-local uniqueness constraint as a compatibility workaround. The tenant-local key is required so one tenant cannot suppress another tenant's legitimate media event.

`POST /api/media/events` now requires the existing `write` permission. Confirm all keys that perform REST or connector media ingest have `write` before stopping writers; no new permission type is introduced.

REST `played_at` validation now rejects malformed timestamps before SQL. Offset-less REST timestamps are preserved for compatibility by treating them as UTC before persistence.

No API keys, user sessions, secrets, environment variables, ingress rules, OAuth scopes, or app manifests change for this rollout. Historical null-owner or spoofed rows are not rewritten or made public by this migration.
