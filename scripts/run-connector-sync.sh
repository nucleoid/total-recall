#!/usr/bin/env bash
# Release-relative connector entrypoint for the deployment scheduler.
set -euo pipefail
die() { printf '[connector] ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || die 'usage: run-connector-sync.sh spotify|ytmusic|plex|browser'
case "$1" in
  spotify) entry=scripts/spotify-sync.ts ;;
  ytmusic) entry=scripts/ytmusic-sync.ts ;;
  plex) entry=scripts/plex-sync.ts ;;
  browser) entry=scripts/browser-history-sync.ts ;;
  *) die 'unknown connector (obsolete phase arguments are not supported)' ;;
esac
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROJECT_DIR=$(realpath -e -- "$SCRIPT_DIR/..") || die 'cannot resolve release directory'
[[ -n ${NODE_BIN:-} && $NODE_BIN == /* && -x $NODE_BIN ]] || die 'NODE_BIN must be an absolute executable path'
TSX_ENTRY="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
[[ -r $TSX_ENTRY && -r "$PROJECT_DIR/$entry" ]] || die 'release dependencies or connector entrypoint missing'
cd -- "$PROJECT_DIR"
exec "$NODE_BIN" "$TSX_ENTRY" "$PROJECT_DIR/$entry"
