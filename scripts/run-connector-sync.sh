#!/usr/bin/env bash
# Release-relative connector entrypoint for the deployment scheduler.
set -euo pipefail
die() { printf '[connector] ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || die 'usage: run-connector-sync.sh spotify|ytmusic|plex|browser'
case "$1" in
  spotify) entry=dist/connector-runtime/spotify.js ;;
  ytmusic) entry=dist/connector-runtime/ytmusic.js ;;
  plex) entry=dist/connector-runtime/plex.js ;;
  browser) entry=dist/connector-runtime/browser.js ;;
  *) die 'unknown connector (obsolete phase arguments are not supported)' ;;
esac
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROJECT_DIR=$(realpath -e -- "$SCRIPT_DIR/..") || die 'cannot resolve release directory'
[[ -n ${NODE_BIN:-} && $NODE_BIN == /* && -x $NODE_BIN ]] || die 'NODE_BIN must be an absolute executable path'
[[ -r "$PROJECT_DIR/$entry" ]] || die 'compiled connector runtime missing; run npm run build:connectors'
cd -- "$PROJECT_DIR"
exec "$NODE_BIN" "$PROJECT_DIR/$entry"
