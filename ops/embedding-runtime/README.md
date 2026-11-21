# Persistent local embedding recovery

These narrowly scoped operational amendments accompany the typed steady-control and resource-diagnostic changes in `src/`. They are not a new database migration and must not replay cutover/backfill.

## Failure model
A private beacon container IP is not an identity: Docker may reassign it. Resolve the canonical DappNode beacon alias through its configured core DNS on every health probe. Refuse arbitrary endpoints, nonprivate answers, redirects and malformed health. The resolver code contains the DappNode core DNS address; keep that configuration aligned if the core network itself changes.

The persistent runtime formerly latched every sampling exception into a permanent fatal receipt. `persistent-cpu-recovery.patch` changes only allowlisted beacon transport/DNS/timeouts and isolated CPU-pressure events into a closed-backend retryable exit75 with a separate transient receipt. A mixed/hard/unknown failure, expired authority, cgroup limit change, model swap, nonfinite metrics, invalid health or inability to stop the backend remains fatal1. Never remove a fatal latch automatically.

## Runtime integration
Apply the runtime patch only to the matching backed-up standalone gateway bundle, checking the patch and input hashes first; the bundle is provisioned separately from the application build. Install `beacon-health.js` and `startup-readiness.js` alongside it. Set both pinned beacon URL fields to `http://beacon-chain.lodestar.dappnode.private:3500/eth/v1/node/syncing`, then update the unit's config SHA256 label/environment to match the actual secure config. Do not publish credentials or approval/config receipt files.

Use a systemd override with `Restart=no`, `RestartForceExitStatus=75`, `RestartSec=60s`, `StartLimitIntervalSec=300`, `StartLimitBurst=4`. Keep the fatal-file absence precondition, and use the same runtime Node binary to run `startup-readiness.js <absolute-content-free-receipt-path>` as the second precondition. Set `TimeoutStartSec=infinity`: readiness waits without loading the model until60 continuous healthy seconds, retaining the original pre-start RAM/disk/CPU/memory/ETH conditions. A failed readiness sample resets that interval; it does not start inference. `systemctl stop` must stay stopped.

## Worker integration
Build the updated application modules normally. Apply `steady-worker-recovery.patch` to the matching backed-up worker and install `steady-recovery-policy.mjs` and `beacon-health.js` in its evidence mount. It invokes the supported transactionally fenced `recoverGuardPausedSteadyWorker` helper only after60 continuous healthy seconds. Exact run/contract/error and the database's textual microsecond-preserving updated_at token are compared in the transaction. A changed generation, cancellation, manual/operator pause or unknown error is not recovered. Keep all other original resource limits and immutable manifest checks.

Original threshold violation readings, limits and labels are now attached to the resource error before unwinding; do not substitute later /proc samples as the original cause.

## Verification
Run `node --test ops/embedding-runtime/*.test.mjs`, affected resource/steady TS tests and TypeScript checking. The standalone runtime patch has its separate guard/entrypoint suite against its actual bundle. Test real systemd semantics with a disposable service: exit75 once, verify one restart, then explicitly stop and verify no further restart. Do not stop Ethereum or intentionally exhaust the host to test recovery.

Before claiming recovery, verify pinned authenticated local inference, real worker guard-pause recovery, a fresh completed batch, search/new-write indexing, and current model cgroup/ETH health. Record code/config/fatal hashes and backups privately. Preserve this operational overlay on the next release; do not let an application redeploy silently remove it.
