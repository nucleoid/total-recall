# Native passwordless maintenance owner

This lane executes exactly one bounded logical-decay page per invocation through PostgreSQL's existing container-local trust path. It does not distribute an owner password, change PostgreSQL ACLs, replay migrations, run global DDL, purge rows, or accept arbitrary commands.

## Fixed host contract

The only supported launcher is `scripts/native-maintenance-owner-launcher.py`, run as the existing `cass` OS identity `999:994` on the Total Recall host. It accepts no arguments and hardcodes:

- release: `/home/cass/total-recall-move-20261117/release`, mounted read-only at `/app`;
- state: `/home/cass/total-recall-native-maintenance-owner`, mode 0700, mounted read-write at `/job`;
- image identity: read from the running `total-recall-ingestion-worker-1` container;
- network namespace: `container:total-recall-db-1`;
- database URLs: `postgresql://postgres@127.0.0.1:5432/total_recall`, with no password;
- container identity `999:994`, read-only root, all capabilities dropped, `no-new-privileges`, 256 MiB memory, 0.25 CPU, 64 PIDs, and a 32 MiB noexec tmpfs;
- fixed thread caps `GOMAXPROCS=2`, `UV_THREADPOOL_SIZE=1`, and Node `--v8-pool-size=1`, preventing the tsx/esbuild startup path from exhausting the unchanged 64-PID budget.

The launcher uses a nonblocking kernel `flock` in the fixed state directory, so overlapping scheduler/controller calls fail immediately. It invokes Docker with an argument vector, never a shell or caller-provided command. The parent controller may whitelist this exact launcher path; it must not expose a generic remote command facility.

## Runner invariants

`scripts/native-maintenance-owner.ts` accepts no arguments and rejects any database URL other than the fixed passwordless loopback URL. Before every invocation it verifies `current_database()='total_recall'`, `current_role='postgres'`, zero NULL `relevance_base_score` rows, and the finalized NOT NULL column. A failed preflight performs no maintenance write.

Each invocation applies at most 100 valid-current, active, unsuperseded, unconsolidated rows with a fixed UTC `asOf` and UUID cursor. The bounded native decay transaction uses ordinary row locks with a 5-second lock timeout and 30-second statement timeout, so its UUID cursor cannot skip a temporarily locked row. It rechecks current statement-time expiry and lifecycle while the row is locked. It only updates derived relevance score and `updated_at`; content, source, ownership, ACL, access history, and lifecycle are unchanged. It never calls TTL purge.

State and the content-free last receipt are atomically replaced with file and directory fsync and mode 0600. A crash after database commit but before state replacement safely replays the same page at the same `asOf`; unchanged rows produce zero score updates. A page with fewer than 100 candidates marks the pass complete. Further invocations that UTC day are preflighted no-ops. A new pass starts only on a later UTC day; an unfinished pass continues across days until it reaches the end. There is no internal loop.

Receipt fields contain only role/database identity, UTC day, fixed `asOf`, UUID cursors, selected/updated counts, namespace counts, completion state, and timestamps. They contain no memory content or credentials.

## Installation and scheduling

1. Package the reviewed TypeScript runner and Python launcher in the immutable release. Verify both are owned by `999:994`; the release remains mode 0755 and non-writable by group/other.
2. Run the launcher once manually through the same fixed host identity. Confirm the receipt reports finalized classifications, at most 100 selected rows, and no deletion or source/history change.
3. The product scheduler/controller may invoke the exact launcher periodically while a pass is incomplete. One invocation performs one page and exits; do not wrap it in a busy loop. Calls after pass completion are harmless same-day no-ops.
4. Verify `/home/cass/total-recall-native-maintenance-owner/state.json` and `last-receipt.json` are mode 0600 and that cursor/asOf advance only as documented.
5. On failure, stop scheduling and inspect only the content-free receipt and container exit status. Do not add passwords, weaken the fixed role/path checks, grant app/admin privileges, run purge, or manually skip a cursor. Restore the prior state file only from a reviewed host backup and expect same-`asOf` replay.

No database migration or PostgreSQL configuration change is required. Parent operations own release installation, the whitelisted controller action, schedule cadence, and live verification.
