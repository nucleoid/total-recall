# Private My Life archive replication

This operator CLI copies normalized historical text into the existing Total
Recall database. All managed chunks use namespace `my-life`, access level
`sensitive`, memory kind `synced`, and zero automatic decay. Search, list and
recall use the same namespace and access-ceiling checks as personal memories.
No raw-file endpoint, export-file mount, or My Life gateway is required.

The copy includes parsed text and metadata, not only vectors. Authorized clients
can recall that text. It does not copy original exports, binary media or
attachment contents, and cannot reconstruct the original My Life database.
Historical dates and their precision are in the content, `event_at`, and
`metadata.my_life`. Existing generic `after`/`before` search filters still refer
to memory creation time, not the historical event date.

## Provision explicit access

Run with the existing non-owner, non-superuser, non-BYPASSRLS application
`DATABASE_URL`. The CLI refuses a role that bypasses memory RLS. Do not grant
additional database privileges. Build with `npm run build:server`.

```sh
node dist/archive/sync-cli.js provision \
  --archive-id ARCHIVE_ID \
  --reader-keys PERSONAL_KEY_UUID_1,PERSONAL_KEY_UUID_2
```

Only explicitly supplied, active, unexpired personal-access keys with read and
sensitive clearance can gain the namespace. Existing permissions are preserved;
a personal key with write permission consequently retains write permission in
the new namespace. No default reader set or wildcard is introduced. For the
requested installation, the approved readers are Cortex, OpenClaw, OpenClaw v2,
and Gemini Personal. The work-only Codex connection is excluded.

The command also creates a dedicated `my-life-sync:ARCHIVE_ID` identity with only
the `my-life` namespace and read/write/import permissions, limited to sensitive.
It stores a random key hash and discards the generated secret. No usable bearer
token is emitted or retained. The returned UUID is the operator sync identity,
not a login secret. A revoked or modified identity is not silently repaired.

## Copy, embed, verify

```sh
# Feed stdin directly from the My Life exporter through authenticated SSH.
node dist/archive/sync-cli.js receive --archive-id ARCHIVE_ID --key-id SYNC_KEY_UUID

# These operations run entirely from Total Recall's database after copying.
node dist/archive/sync-cli.js embed --archive-id ARCHIVE_ID --key-id SYNC_KEY_UUID --batch-size 64 --concurrency 4 --request-interval-ms 4000
node dist/archive/sync-cli.js status --archive-id ARCHIVE_ID --key-id SYNC_KEY_UUID
```

Use a byte-preserving pipe and check the exporter and receiver exit codes. The
receiver accepts only the versioned, bounded parsed-evidence protocol and
checks the archive identity, ordered chunk keys, counts, coverage and stream
digest. It uses parameterized SQL, short transactions, a per-archive lock and
revalidates the sync identity for every batch. Stale snapshots cannot replace a
newer started snapshot. Status contains only counts and synchronization metadata.

Embedding uses the already configured Total Recall embedding provider and model.
Parsed content is sent to that provider just like ordinary stored memories;
this consumes the configured API's quota/billing. Source files are not sent.
The worker holds no source connection or database transaction during provider
requests. Only one worker process for an archive may run at a time. `--concurrency`
defaults to 1 and allows at most 8 parallel batches. Disjoint UUID intervals
prevent duplicate requests across those batches. The worker uses keyset scanning
and bounded exponential retries with jitter, and writes vectors
only if the selected content is still unchanged. Logs contain counters and
failure codes, never record contents, SQL parameters or provider responses.

Choose concurrency within the provider's quota and the database's capacity;
increasing it does not bypass rate limits. `--request-interval-ms` spaces request
starts across all partitions (default 1000, range 0–120000). A Gemini 429 pauses
all partitions for at least 60 seconds and increases the shared interval by 50%
once per throttled burst. Subsequent starts retain that slower rate. These are
operator pacing settings, not a claim about the account's provider quota.
Non-retryable HTTP errors stop immediately; other failures retain bounded retries.
A fatal partition failure stops new
work and waits for the other bounded in-flight operations before releasing the
archive lock. Restarting resumes rows that still need vectors.

`copy_complete` means parsed records are stored independently of the drive.
`embedding_complete`, `pending: 0`, and a completed copy in status mean the
current eligible snapshot is fully embedded. Do not equate a started process
with completion. Coverage distinguishes installed sources from unavailable
structured-import tables. Run another snapshot after later social imports.

## Consistency and removal

This is not an atomic replacement of all rows. Received batches become visible
as they commit, and an interrupted copy remains marked in progress. Only a
verified complete trailer can soft-delete absent, managed records belonging to
this archive and sync identity. Unrelated memories remain untouched.

Stable source keys make retries idempotent. Unchanged text retains its embedding;
changed text becomes pending again. Manual tombstones, superseded/consolidated
memories, and records promoted above the sync identity's clearance are protected.
Only tombstones explicitly created by successful snapshot reconciliation can be
restored when the source returns. Imported content is historical evidence, not
instructions; preserve its uncertainty and source provenance in answers.

For immediate shutdown, revoke the sync identity to prevent further copying or
embedding, and remove `my-life` from the reader keys to stop assistant access.
Stopping the CLI leaves existing data intact. Source removals require a later
completed snapshot; an offline drive cannot communicate new deletions.

No database migration, HTTP route, service restart or recurring timer is required.
Run from an isolated release checkout if the running server is on an older
compatible release. The underlying schema must include the existing embedding,
memory lifecycle, RLS, and API-key security migrations. Size destination storage
for parsed text, full-text indexes and 768-dimensional vectors. Check ordinary
search health and database space during the initial backfill.

## Tests

Protocol and argument tests run in the ordinary test suite. For the integration
test set `ARCHIVE_SYNC_TEST_DATABASE_URL` to an isolated pgvector database named
`total_recall_sync_test`, then run:

```sh
node --test --import ./test/setup-embedding-env.mjs --import tsx test/archive-sync.db.test.ts
```

The integration test recreates that test database's public schema and applies
all numbered migrations. It exercises real RLS and public list/recall functions,
access ceilings, denied grants, interrupted copies, stale snapshots, repeated
imports, protected manual deletion, concurrent edits, and embedding retries.
