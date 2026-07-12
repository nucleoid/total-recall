#!/usr/bin/env bash
# Linux scheduler fallback for Total Recall. Prefer one systemd service as owner.
set -euo pipefail
umask 077

log() { printf '[sync] %s\n' "$*"; }
die() { printf '[sync] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Linux && -r /proc/self/cmdline ]] ||
  die 'daily-sync.sh supports Linux with /proc only (not Windows or macOS)'
command -v flock >/dev/null 2>&1 || die 'flock is required'
command -v realpath >/dev/null 2>&1 || die 'realpath is required'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROJECT_INPUT=${PROJECT_DIR:-"$SCRIPT_DIR/.."}
[[ $PROJECT_INPUT != *$'\n'* ]] || die 'PROJECT_DIR must not contain a newline'
PROJECT_DIR=$(realpath -e -- "$PROJECT_INPUT") || die 'PROJECT_DIR does not exist'
[[ -d $PROJECT_DIR ]] || die 'PROJECT_DIR is not a directory'
WATCHER_ENTRY="$PROJECT_DIR/dist/watcher.js"
[[ -f $WATCHER_ENTRY && -r $WATCHER_ENTRY ]] || die "watcher build is not readable: $WATCHER_ENTRY"

[[ -n ${NODE_BIN:-} ]] || die 'NODE_BIN must be an absolute executable path'
[[ $NODE_BIN == /* && $NODE_BIN != *$'\n'* ]] || die 'NODE_BIN must be an absolute path without newlines'
[[ -x $NODE_BIN && ! -d $NODE_BIN ]] || die "NODE_BIN is not executable: $NODE_BIN"
NODE_REAL=$(realpath -e -- "$NODE_BIN") || die 'NODE_BIN cannot be resolved'
[[ $NODE_REAL == /* && -x $NODE_REAL ]] || die 'resolved NODE_BIN is not executable'
timeout=${STARTUP_TIMEOUT_SECONDS:-5}
[[ $timeout =~ ^[1-9][0-9]*$ ]] || die 'STARTUP_TIMEOUT_SECONDS must be a positive integer'
lock_timeout=${LOCK_TIMEOUT_SECONDS:-10}
[[ $lock_timeout =~ ^[1-9][0-9]*$ ]] || die 'LOCK_TIMEOUT_SECONDS must be a positive integer'

uid=$(id -u)
validate_private_dir() {
  local dir=$1 owner mode
  [[ -d $dir && ! -L $dir ]] || die "unsafe runtime directory (must be a real directory): $dir"
  owner=$(stat -c %u -- "$dir") || die "cannot inspect runtime directory: $dir"
  mode=$(stat -c %a -- "$dir") || die "cannot inspect runtime directory: $dir"
  [[ $owner == "$uid" ]] || die "runtime directory is not owned by uid $uid: $dir"
  (( (8#$mode & 077) == 0 )) || die "runtime directory permits group/other access: $dir"
}

if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
  [[ $XDG_RUNTIME_DIR == /* && $XDG_RUNTIME_DIR != *$'\n'* ]] ||
    die 'XDG_RUNTIME_DIR must be an absolute path without newlines'
  validate_private_dir "$XDG_RUNTIME_DIR"
  RUNTIME_DIR="$XDG_RUNTIME_DIR/total-recall"
else
  RUNTIME_DIR="/tmp/total-recall-$uid"
fi
[[ ! -L $RUNTIME_DIR ]] || die "refusing symlink runtime directory: $RUNTIME_DIR"
if [[ ! -e $RUNTIME_DIR ]]; then
  mkdir -m 0700 -- "$RUNTIME_DIR" || die "cannot create runtime directory: $RUNTIME_DIR"
fi
validate_private_dir "$RUNTIME_DIR"

LOCKFILE="$RUNTIME_DIR/watcher.lock"
PIDFILE="$RUNTIME_DIR/watcher.pid"
LOGFILE="$RUNTIME_DIR/watcher.log"
for path in "$LOCKFILE" "$PIDFILE" "$LOGFILE"; do
  [[ ! -L $path ]] || die "refusing symlink runtime file: $path"
done

exec 9>"$LOCKFILE"
flock -x -w "$lock_timeout" 9 || die 'another daily-sync run holds the lock'

process_state() {
  local pid=$1 rest
  [[ -r /proc/$pid/stat ]] || return 1
  IFS= read -r rest <"/proc/$pid/stat" || return 1
  rest=${rest##*) }
  [[ ${rest%% *} != Z ]]
}

read_argv() {
  local pid=$1
  PROC_ARGV=()
  [[ -r /proc/$pid/cmdline ]] || return 1
  mapfile -d '' -t PROC_ARGV <"/proc/$pid/cmdline" || true
  ((${#PROC_ARGV[@]} > 0))
}

observed_node() {
  local pid=$1 exe candidate base deleted_suffix=' (deleted)'
  exe=$(readlink -- "/proc/$pid/exe" 2>/dev/null) || return 1
  candidate=$exe
  if [[ $candidate == *"$deleted_suffix" ]]; then
    candidate=${candidate%"$deleted_suffix"}
  fi
  base=${candidate##*/}
  [[ $base == node || $base == nodejs ]] || return 1
  [[ $exe != *"$deleted_suffix" ]] || return 2
  exe=$(realpath -e -- "/proc/$pid/exe" 2>/dev/null) || return 2
  [[ -x $exe ]] || return 2
  printf '%s\n' "$exe"
}

# Exact absolute invocation, or the one legacy relative invocation in this project cwd.
watcher_invocation() {
  local pid=$1 cwd
  process_state "$pid" || return 1
  [[ $(stat -c %u -- "/proc/$pid" 2>/dev/null) == "$uid" ]] || return 1
  read_argv "$pid" || return 1
  ((${#PROC_ARGV[@]} == 2)) || return 1
  if [[ ${PROC_ARGV[1]} == "$WATCHER_ENTRY" ]]; then
    return 0
  fi
  [[ ${PROC_ARGV[1]} == 'dist/watcher.js' ]] || return 1
  cwd=$(realpath -e -- "/proc/$pid/cwd" 2>/dev/null) || return 1
  [[ $cwd == "$PROJECT_DIR" ]]
}

match_watcher() {
  local pid=$1
  watcher_invocation "$pid" || return 1
  MATCHED_EXE=$(observed_node "$pid") || return 1
}

write_pidfile() {
  local pid=$1 tmp
  tmp=$(mktemp "$RUNTIME_DIR/.watcher.pid.XXXXXX") || die 'cannot create temporary pidfile'
  TEMP_PIDFILE=$tmp
  printf '%s\n' "$pid" >"$tmp"
  mv -f -- "$tmp" "$PIDFILE"
  TEMP_PIDFILE=
}
TEMP_PIDFILE=
trap '[[ -z ${TEMP_PIDFILE:-} ]] || rm -f -- "$TEMP_PIDFILE"' EXIT INT TERM HUP

owned_pid=
if [[ -e $PIDFILE ]]; then
  [[ ! -L $PIDFILE && -f $PIDFILE ]] || die "unsafe pidfile: $PIDFILE"
  pid_text=$(<"$PIDFILE")
  if [[ $pid_text =~ ^[1-9][0-9]*$ ]] && match_watcher "$pid_text"; then
    owned_pid=$pid_text
  else
    rm -f -- "$PIDFILE"
  fi
fi

matches=()
unverified=()
for proc in /proc/[0-9]*; do
  pid=${proc##*/}
  if watcher_invocation "$pid"; then
    if MATCHED_EXE=$(observed_node "$pid"); then
      matches+=("$pid:$MATCHED_EXE")
    elif [[ $? -eq 2 ]]; then
      unverified+=("$pid")
    fi
  fi
done

if ((${#unverified[@]} > 0)); then
  die "watcher-shaped process has an unverifiable Node executable (pid ${unverified[*]}); inspect it manually"
elif ((${#matches[@]} > 1)); then
  die "multiple matching watchers found (${matches[*]}); stop surplus processes and choose one owner"
fi

if [[ -n $owned_pid && ${#matches[@]} == 1 && ${matches[0]%%:*} == "$owned_pid" ]]; then
  log "Watcher already running (pid $owned_pid)"
else
  if [[ -n $owned_pid ]]; then
    [[ -f $PIDFILE && $(<"$PIDFILE") == "$owned_pid" ]] && rm -f -- "$PIDFILE"
    owned_pid=
  fi
  if ((${#matches[@]} == 1)); then
    owned_pid=${matches[0]%%:*}
    observed_exe=${matches[0]#*:}
    write_pidfile "$owned_pid"
    if [[ $observed_exe != "$NODE_REAL" ]]; then
      log "WARNING: adopted watcher pid $owned_pid uses $observed_exe, not configured $NODE_REAL"
    fi
    log "Watcher already running; adopted pid $owned_pid"
  else
    [[ ! -L $LOGFILE ]] || die "refusing symlink log file: $LOGFILE"
    nohup "$NODE_BIN" "$WATCHER_ENTRY" 9>&- >>"$LOGFILE" 2>&1 &
    owned_pid=$!
    write_pidfile "$owned_pid"

    checks=$((timeout * 10))
    seen_valid=false
    started=false
    for ((check = 0; check < checks; check++)); do
      if match_watcher "$owned_pid" && [[ $MATCHED_EXE == "$NODE_REAL" ]]; then
        seen_valid=true
      elif ! process_state "$owned_pid" || [[ $seen_valid == true ]]; then
        break
      fi
      sleep 0.1
    done
    if [[ $seen_valid == true ]] && match_watcher "$owned_pid" && [[ $MATCHED_EXE == "$NODE_REAL" ]]; then
      started=true
    fi
    if [[ $started != true ]]; then
      [[ -f $PIDFILE && $(<"$PIDFILE") == "$owned_pid" ]] && rm -f -- "$PIDFILE"
      die "watcher failed startup validation; inspect $LOGFILE"
    fi
    log "Watcher started (pid $owned_pid)"
  fi
fi

# Stats are optional and never change a healthy watcher result.
log 'Memory stats:'
if [[ -n ${MCPORTER_BIN:-} && $MCPORTER_BIN == /* && -x $MCPORTER_BIN &&
      -n ${PYTHON3_BIN:-} && $PYTHON3_BIN == /* && -x $PYTHON3_BIN ]]; then
  if stats_json=$("$MCPORTER_BIN" call total-recall.memory_stats 2>/dev/null) &&
     stats_out=$(printf '%s' "$stats_json" | "$PYTHON3_BIN" -c '
import json, sys
d = json.load(sys.stdin)
print("  Total: {} memories".format(d["total_memories"]))
for ns in d.get("by_namespace", []):
    print("  {}: {}".format(ns["namespace"], ns["count"]))
print("  Newest: {}".format(d.get("newest_memory", "?")))
' 2>/dev/null); then
    printf '%s\n' "$stats_out"
  else
    echo '  (stats unavailable)'
  fi
else
  echo '  (stats unavailable)'
fi

log "Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
