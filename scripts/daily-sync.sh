#!/bin/bash
# Daily sync for Total Recall — ensures watcher is running & files are current
set -euo pipefail

PROJECT_DIR="/home/fuego/projects/total-recall"
cd "$PROJECT_DIR"

# 1. Ensure watcher is running
if ! pgrep -f "total-recall/dist/watcher.js" > /dev/null 2>&1; then
  echo "[sync] Watcher not running, starting..."
  nohup node dist/watcher.js >> /tmp/total-recall-watcher.log 2>&1 &
  sleep 2
  echo "[sync] Watcher started"
else
  echo "[sync] Watcher already running"
fi

# 2. Stats check
echo "[sync] Memory stats:"
mcporter call total-recall.memory_stats 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  Total: {d[\"total_memories\"]} memories')
for ns in d.get('by_namespace', []):
    print(f'  {ns[\"namespace\"]}: {ns[\"count\"]}')
print(f'  Newest: {d.get(\"newest_memory\", \"?\")}')
" 2>/dev/null || echo "  (stats unavailable)"

echo "[sync] Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
