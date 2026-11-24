#!/usr/bin/env bash
# Observe the deployed Compose watcher; never start or adopt a process.
set -euo pipefail
ids=$(/usr/bin/docker ps -q --filter label=com.docker.compose.project=total-recall --filter label=com.docker.compose.service=watcher)
[[ -n "$ids" && "$ids" != *$'\n'* ]] || { echo 'Expected exactly one running Total Recall watcher' >&2; exit 1; }
state=$(/usr/bin/docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.State.OOMKilled}}' "$ids")
[[ "$state" == 'true false false' ]] || { echo 'Watcher runtime unhealthy' >&2; exit 1; }
/usr/bin/docker exec "$ids" node -e 'const fs=require("node:fs");const a=fs.readFileSync("/proc/1/cmdline","utf8");if(!a.includes("watcher-start.mjs"))process.exit(1)'
echo 'Exactly one externally managed Docker watcher running; no process started or adopted.'
