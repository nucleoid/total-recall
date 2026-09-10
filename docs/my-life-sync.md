# Private My Life archive replication

This operator CLI copies normalized historical text into the existing Total
Recall database. All managed chunks use namespace `my-life`, access level
`sensitive`, memory kind `synced`, and zero automatic decay. Search, list and
recall use the same namespace and access-ceiling checks as personal memories.
No raw-file endpoint, export-file mount, or My Life gateway is required.

Archive search is explicit: pass `namespaces: ["my-life"]`, or combine it with
`["personal", "my-life"]`. Default searches exclude `my-life` even for approved
keys, preserving the ordinary personal-search corpus. Namespace grants still
control access; this default does not grant any new client permission. Deploy
the updated server search module and restart it when adopting this behavior.

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

# Resume interrupted pruning after the full stream was hash-verified and saved.
node dist/archive/sync-cli.js finalize --archive-id ARCHIVE_ID --key-id SYNC_KEY_UUID

# After correcting a record/provider problem, retry failed rows without a re-export.
node dist/archive/sync-cli.js retry-failed --archive-id ARCHIVE_ID --key-id SYNC_KEY_UUID
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
requests. It does retain one destination database session per active partition,
plus a session for its process lock. Only one worker process for an archive may run at a time. `--concurrency`
defaults to 1 and allows at most 8 parallel batches. Disjoint UUID intervals
prevent duplicate requests across those batches. The worker uses keyset scanning
and bounded exponential retries with jitter, and writes vectors
only if the selected content is still unchanged. Logs contain counters and
failure codes, never record contents, SQL parameters or provider responses.

Choose concurrency within the provider's quota and the database's capacity;
increasing it does not bypass rate limits. `--request-interval-ms` spaces request
starts across all partitions (default 1000, range 0–120000). A Gemini 429 pauses
all partitions for at least 60 seconds and increases the shared interval by 50%
once per throttled burst. After eight successful requests and at least a minute
without a rate change, the interval decreases by 20%, bounded by the configured
starting interval. Successes from requests started before a throttle cannot
accelerate recovery. Progress logs report the interval. These are
operator pacing settings, not a claim about the account's provider quota.
Input-related HTTP 400/413/422 failures split batches to isolate rejected rows.
Single-row failures receive a content-free failure marker; healthy rows continue.
Eight failed rows in one batch stop further splitting to bound a possible
configuration failure. Authentication errors stop immediately; transient failures
retain bounded retries. `status.failed` reports rejected rows separately from
pending work. Any failed rows prevent `embedding_complete`; the worker exits with
`archive_sync.embedding_records_failed`. `retry-failed` requires the worker to be
stopped and clears those markers in bounded batches for an explicit retry.
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

The verified trailer is saved before pruning. Cleanup commits at most 500 rows
per transaction and saves its UUID cursor. If cleanup is interrupted, `finalize`
resumes entirely from the destination database; another stream is refused until
that verified cleanup finishes. An interrupted input stream without a valid
trailer still requires a fresh source export.

Sensitive imports are deliberately excluded from entity extraction. Trigger-created
queue entries are resolved within each import transaction with status `done` and
reason `archive_sync.sensitive_source_excluded`; they leave the pending claim
index. The rows remain as an exclusion audit, and resync resolves old pending
entries. This does not authorize an entity provider to process private text.

Stable source keys make retries idempotent. Unchanged text retains its embedding;
changed text becomes pending again. Manual tombstones, superseded/consolidated
memories, and records promoted above the sync identity's clearance are protected.
Only tombstones explicitly created by successful snapshot reconciliation can be
restored when the source returns. Imported content is historical evidence, not
instructions; preserve its uncertainty and source provenance in answers.

For a temporary pause, stop the CLI or disable its existing identity. Remove
`my-life` from the reader keys to suspend assistant access. Revocation is an
emergency stop; provisioning never silently reverses it. Disabled or revoked
identities produce `archive_sync.identity_requires_operator_recovery`. To resume,
an authorized operator must restore the same identity row (its existing UUID,
single `my-life` namespace, read/write/import permissions and sensitive ceiling),
clearing revocation or enabling it only after the reason for shutdown is resolved.
Do not create a replacement UUID: managed rows belong to the original identity.
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

## Additional recovery and boundary checks

The receiver independently rejects serialized Calendar component markers in Calendar chunks and requires every declared exclusion in the completion trailer. This is a targeted guard, not a classifier of arbitrary private email prose: parsed email bodies can legitimately discuss file formats. Raw field exclusion is enforced by the reviewed source projections.

A completed snapshot that decreases any previously substantial origin (at least 100 records) by more than 10% is refused before pruning. Inspect the source/database identity and coverage. Only for a deliberate removal, repeat `receive` with `--allow-shrink true`. Already committed new chunks remain visible; the prior completed snapshot is preserved and finalization cannot bypass the size guard.

Each finite embedding run stops after 32 input-class provider failures across all batches and partitions, including bisect requests. This bounds extra paid requests for a systemic input problem. Fix the cause before explicitly restarting; `retry-failed` uses a UUID cursor to clear failure markers in batches of 500. Status aggregation has a separate five-minute read-only statement limit.

The explicit archive opt-in applies to `memory_search`. Authorized `memory_list`, graph and transfer-export operations retain their existing namespace defaults; request namespaces explicitly when using those operations. No client gains additional permissions. Existing sensitive enrichment jobs are retired on the next corrected full snapshot; the state job is also retired at snapshot start. Existing deleted/quarantined leftovers require a scoped operator cleanup.


Parsed URLs and remote references are intentionally retained as untrusted text in the private copy. My Life's UI redacts remote references for rendering; this archive transfer preserves their historical meaning and does not fetch them. Clients must not automatically follow source links. A refused shrink protects prior rows from pruning; it does not roll back already committed batches or prove database identity. Verify source installation and inspect coverage before transfer. A partial copy is explicitly visible, as with interrupted receives.

For the search rollout, build from the exact deployed server revision with only reviewed `src/search.ts`, `src/tools/search.ts` and `src/archive/sync-format.ts` applied. Keep the tested CLI in a separate isolated release. Preserve existing service environment and arguments; activate the server build with one task-owned drop-in and roll it back if health fails.
