#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]] || [[ ! -r /proc/self/cmdline ]] ||
   ! command -v flock >/dev/null || ! command -v python3 >/dev/null; then
  echo "SKIP daily-sync integration tests require Linux with /proc, flock, and python3"
  exit 0
fi

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -rf -- "$TMP"
}
trap cleanup EXIT INT TERM

fail() { echo "not ok - $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

make_fixture() {
  PROJECT="$TMP/project with spaces"
  RUNTIME="$TMP/runtime with spaces"
  mkdir -p -- "$PROJECT/dist" "$RUNTIME"
  chmod 0700 "$RUNTIME"
  cp "$(command -v python3)" "$TMP/node"
  chmod 0700 "$TMP/node"
  cat >"$PROJECT/dist/watcher.js" <<'PY'
import os, time
with open(os.environ["WATCHER_COUNT_FILE"], "a", encoding="utf-8") as stream:
    stream.write(f"{os.getpid()}\n")
time.sleep(60)
PY
  : >"$TMP/starts"
}

run_sync() {
  env PROJECT_DIR="$PROJECT" NODE_BIN="$TMP/node" XDG_RUNTIME_DIR="$RUNTIME" \
    WATCHER_COUNT_FILE="$TMP/starts" STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-2}" \
    LOCK_TIMEOUT_SECONDS="${LOCK_TIMEOUT_SECONDS:-2}" \
    MCPORTER_BIN="${MCPORTER_BIN:-}" PYTHON3_BIN="${PYTHON3_BIN:-}" \
    bash "$ROOT/scripts/daily-sync.sh"
}

make_fixture
mkdir -m 0700 -- "$RUNTIME/total-recall"
(
  flock -x 9
  : >"$TMP/lock-held"
  sleep 3
) 9>"$RUNTIME/total-recall/watcher.lock" & lock_holder=$!
PIDS+=("$lock_holder")
for _ in {1..20}; do [[ -e $TMP/lock-held ]] && break; sleep 0.05; done
set +e
LOCK_TIMEOUT_SECONDS=1 run_sync >"$TMP/lock-timeout.out" 2>"$TMP/lock-timeout.err"
lock_timeout_rc=$?
set -e
[[ $lock_timeout_rc -ne 0 ]] || fail "overlapping invocation waited indefinitely for the startup lock"
grep -q 'another daily-sync run holds the lock' "$TMP/lock-timeout.err" || fail "lock timeout was not actionable"
wait "$lock_holder"
PIDS=()
pass "overlapping invocations fail after a bounded lock wait"

run_sync >"$TMP/first.out"
pidfile="$RUNTIME/total-recall/watcher.pid"
[[ -r "$pidfile" ]] || fail "first run did not create pidfile"
pid=$(<"$pidfile")
PIDS+=("$pid")
kill -0 "$pid" 2>/dev/null || fail "first run watcher is not alive"
grep -q 'Watcher started' "$TMP/first.out" || fail "first run did not report successful start"

run_sync >"$TMP/repeat.out"
grep -q 'Watcher already running' "$TMP/repeat.out" || fail "repeat did not recognize watcher"

run_sync >"$TMP/concurrent-1.out" & one=$!
run_sync >"$TMP/concurrent-2.out" & two=$!
wait "$one"
wait "$two"
[[ $(wc -l <"$TMP/starts") -eq 1 ]] || fail "repeated/concurrent runs started more than one watcher"
[[ $(<"$pidfile") == "$pid" ]] || fail "repeated/concurrent runs replaced the owned watcher"
pass "first, repeated, and concurrent runs leave one validated watcher"

WATCHER_COUNT_FILE="$TMP/starts" "$TMP/node" "$PROJECT/dist/watcher.js" & late_duplicate=$!
PIDS+=("$late_duplicate")
for _ in {1..20}; do [[ $(wc -l <"$TMP/starts") -ge 2 ]] && break; sleep 0.05; done
set +e
run_sync >"$TMP/late-duplicate.out" 2>"$TMP/late-duplicate.err"
late_duplicate_rc=$?
set -e
[[ $late_duplicate_rc -ne 0 ]] || fail "valid pidfile hid a later duplicate watcher"
[[ $(wc -l <"$TMP/starts") -eq 2 ]] || fail "late duplicate detection started another watcher"
grep -q 'multiple matching watchers' "$TMP/late-duplicate.err" || fail "late duplicate failure is not actionable"
[[ $(<"$pidfile") == "$pid" ]] || fail "late duplicate detection changed the owned pidfile"
kill "$late_duplicate" 2>/dev/null || true
wait "$late_duplicate" 2>/dev/null || true
PIDS=("$pid")
pass "a valid pidfile does not hide a later competing watcher"

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"
cat >"$PROJECT/dist/watcher.js" <<'PY'
import time
time.sleep(1.8)
PY

set +e
run_sync >"$TMP/immediate.out" 2>"$TMP/immediate.err"
immediate_rc=$?
set -e
[[ $immediate_rc -ne 0 ]] || fail "immediate child exit was reported as a successful start"
! grep -q 'Watcher started' "$TMP/immediate.out" || fail "immediate child exit printed started"
[[ ! -e $pidfile ]] || fail "failed child left its pidfile behind"
grep -q 'watcher failed startup validation' "$TMP/immediate.err" || fail "startup failure did not report validation failure"
pass "immediate child exit fails startup and removes its pidfile"

rm -f -- "$pidfile"
: >"$TMP/starts"
cat >"$PROJECT/dist/watcher.js" <<'PY'
import os, time
with open(os.environ["WATCHER_COUNT_FILE"], "a", encoding="utf-8") as stream:
    stream.write(f"{os.getpid()}\n")
time.sleep(60)
PY
set +e
STARTUP_TIMEOUT_SECONDS=0 run_sync >"$TMP/bad-timeout.out" 2>"$TMP/bad-timeout.err"
bad_timeout_rc=$?
set -e
[[ $bad_timeout_rc -ne 0 ]] || fail "invalid startup timeout was accepted"
[[ ! -s $TMP/starts ]] || {
  launched=$(tail -n 1 "$TMP/starts")
  PIDS+=("$launched")
  fail "invalid startup timeout launched a watcher before validation"
}
[[ ! -e $pidfile ]] || fail "invalid startup timeout created a pidfile"
pass "scheduler configuration is validated before launch"

rm -f -- "$pidfile"
: >"$TMP/starts"
STARTUP_TIMEOUT_SECONDS=1 run_sync >"$TMP/stats-start.out"
stats_pid=$(<"$pidfile")
PIDS+=("$stats_pid")
cat >"$TMP/mcporter" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"total_memories":3,"by_namespace":[{"namespace":"shared","count":2}],"newest_memory":"today"}'
SH
chmod 0700 "$TMP/mcporter"
MCPORTER_BIN="$TMP/mcporter" PYTHON3_BIN="$(command -v python3)" run_sync >"$TMP/stats.out"
grep -q 'Total: 3 memories' "$TMP/stats.out" || fail "valid optional stats output was not rendered"
grep -q 'shared: 2' "$TMP/stats.out" || fail "valid namespace stats output was not rendered"
pass "valid optional stats tools render memory statistics"

kill "$stats_pid" 2>/dev/null || true
wait "$stats_pid" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"
: >"$TMP/starts"
mkdir -p "$TMP/old node/bin"
cp "$(command -v python3)" "$TMP/old node/bin/node"
chmod 0700 "$TMP/old node/bin/node"
old_node="$TMP/old node/bin/node"
WATCHER_COUNT_FILE="$TMP/starts" "$old_node" "$PROJECT/dist/watcher.js" & old_pid=$!
PIDS+=("$old_pid")
for _ in {1..20}; do [[ -s $TMP/starts ]] && break; sleep 0.05; done
run_sync >"$TMP/adopt-absolute.out"
[[ $(<"$pidfile") == "$old_pid" ]] || fail "absolute watcher using older Node was not adopted"
grep -q 'WARNING: adopted watcher' "$TMP/adopt-absolute.out" || fail "older Node adoption did not warn"
kill "$old_pid" 2>/dev/null || true
wait "$old_pid" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"

: >"$TMP/starts"
(cd "$PROJECT" && WATCHER_COUNT_FILE="$TMP/starts" exec "$old_node" dist/watcher.js) & legacy_pid=$!
PIDS+=("$legacy_pid")
for _ in {1..20}; do [[ -s $TMP/starts ]] && break; sleep 0.05; done
run_sync >"$TMP/adopt-legacy.out"
[[ $(<"$pidfile") == "$legacy_pid" ]] || fail "exact legacy project-cwd watcher was not adopted"
kill "$legacy_pid" 2>/dev/null || true
wait "$legacy_pid" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"
pass "one exact absolute or project-scoped legacy watcher is adopted across Node upgrades"

: >"$TMP/starts"
WATCHER_COUNT_FILE="$TMP/starts" "$old_node" "$PROJECT/dist/watcher.js" & duplicate_one=$!
WATCHER_COUNT_FILE="$TMP/starts" "$TMP/node" "$PROJECT/dist/watcher.js" & duplicate_two=$!
PIDS+=("$duplicate_one" "$duplicate_two")
for _ in {1..20}; do [[ $(wc -l <"$TMP/starts") -ge 2 ]] && break; sleep 0.05; done
set +e
run_sync >"$TMP/duplicates.out" 2>"$TMP/duplicates.err"
duplicates_rc=$?
set -e
[[ $duplicates_rc -ne 0 ]] || fail "multiple exact watchers were accepted"
[[ $(wc -l <"$TMP/starts") -eq 2 ]] || fail "duplicate detection started a third watcher"
grep -q 'multiple matching watchers' "$TMP/duplicates.err" || fail "duplicate failure is not actionable"
[[ ! -e $pidfile ]] || fail "duplicate detection claimed ownership in a pidfile"
pass "multiple matching watchers stop without starting or killing a process"

kill "$duplicate_one" "$duplicate_two" 2>/dev/null || true
wait "$duplicate_one" 2>/dev/null || true
wait "$duplicate_two" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"
: >"$TMP/starts"
WATCHER_COUNT_FILE="$TMP/starts" "$(command -v python3)" "$PROJECT/dist/watcher.js" & non_node_pid=$!
PIDS+=("$non_node_pid")
for _ in {1..20}; do [[ -s $TMP/starts ]] && break; sleep 0.05; done
STARTUP_TIMEOUT_SECONDS=1 run_sync >"$TMP/non-node.out"
started_pid=$(<"$pidfile")
PIDS+=("$started_pid")
[[ $(wc -l <"$TMP/starts") -eq 2 ]] || fail "unrelated non-Node process blocked watcher launch"
[[ $started_pid != "$non_node_pid" ]] || fail "unrelated non-Node process was adopted"
kill -0 "$non_node_pid" 2>/dev/null || fail "unrelated non-Node process was killed"
kill "$non_node_pid" "$started_pid" 2>/dev/null || true
wait "$non_node_pid" 2>/dev/null || true
wait "$started_pid" 2>/dev/null || true
PIDS=()
rm -f -- "$pidfile"
pass "a non-Node process that references the entrypoint is ignored"

: >"$TMP/starts"
mkdir -p "$TMP/deleted node"
cp "$(command -v python3)" "$TMP/deleted node/node"
chmod 0700 "$TMP/deleted node/node"
WATCHER_COUNT_FILE="$TMP/starts" "$TMP/deleted node/node" "$PROJECT/dist/watcher.js" & deleted_node_pid=$!
PIDS+=("$deleted_node_pid")
for _ in {1..20}; do [[ -s $TMP/starts ]] && break; sleep 0.05; done
rm -f -- "$TMP/deleted node/node"
set +e
STARTUP_TIMEOUT_SECONDS=1 run_sync >"$TMP/unverified.out" 2>"$TMP/unverified.err"
unverified_rc=$?
set -e
[[ $unverified_rc -ne 0 ]] || fail "watcher with a deleted Node executable was ignored"
[[ $(wc -l <"$TMP/starts") -eq 1 ]] || fail "unverifiable Node watcher caused another launch"
kill -0 "$deleted_node_pid" 2>/dev/null || fail "unverifiable Node watcher was killed"
[[ ! -e $pidfile ]] || fail "unverifiable Node watcher was claimed"
pass "watcher with an unverifiable Node executable causes a safe stop"

ENV_EXAMPLE="$ROOT/scripts/daily-sync.env.example"
[[ -f $ENV_EXAMPLE ]] || fail "scheduler environment example is missing"
bash -n "$ENV_EXAMPLE" || fail "scheduler environment example is not shell-safe"
grep -qi 'systemd' "$ROOT/README.md" || fail "README does not document systemd ownership"
grep -qi 'cron fallback' "$ROOT/README.md" || fail "README does not identify cron as fallback ownership"
grep -qi 'Windows' "$ROOT/README.md" || fail "README does not document Windows non-applicability"
grep -qi 'old bare.*cron\|bare.*crontab' "$ROOT/README.md" || fail "README does not warn that the old bare cron invocation must be replaced"
grep -q '/tmp/total-recall-watcher.log' "$ROOT/README.md" || fail "README does not identify the legacy log path during upgrade"
grep -q '^NODE_BIN=/' "$ENV_EXAMPLE" || fail "environment example does not use an absolute NODE_BIN"
grep -q '"test:daily-sync"' "$ROOT/package.json" || fail "daily sync test command is missing"
grep -q '"test:daily-sync": "node scripts/run-daily-sync-tests.mjs"' "$ROOT/package.json" || fail "daily sync test command is not portable to hosts without Bash"
[[ -f "$ROOT/scripts/run-daily-sync-tests.mjs" ]] || fail "portable daily sync test runner is missing"
grep -q 'test:daily-sync.*test:access-level:db' "$ROOT/package.json" || fail "the full test suite does not include Linux scheduler tests"
pass "Linux scheduler ownership and absolute deployment paths are documented"
