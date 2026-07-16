# PR 141 adversarial review resolution

## Round 1

- The disruptive migration/credential ownership assignment is an intentional requirement of the confirmed #65 plan. The rollout and rollback are explicit in `docs/rollouts/035-activity-connector-foundation.md` and require a verified backup and stopped writers.
- Owner-only admin media visibility is intentional and is now called out as a pre-rollout consumer inventory item.
- Provider and browser subprocess I/O was moved outside database transactions. A session advisory lock spans the state read, fetch, and short persistence transaction; state is optimistically rechecked before event/cursor commit.
- Connector credential and state tables retain surrogate UUID primary keys in addition to owner/source unique indexes.

## Round 2

- Round 2 verified all four code/documentation fixes.
- A checked-out pool slot remains occupied while a source fetch runs, which is required to hold the PostgreSQL session advisory lock without keeping a transaction open. Connector source execution is sequential and retries/pages are bounded; operators should monitor pool saturation during backfill.
- The SQLite URI concern is disproven by the committed-WAL Chromium and Firefox helper fixtures running successfully on this Windows worker (`python -m unittest test.test_browser_history_helper -v`). The helper fails closed and cleans its restrictive snapshot on errors.
- The remaining rollout approval is already embodied in the confirmed issue plan; there is no unresolved product or technical choice.
