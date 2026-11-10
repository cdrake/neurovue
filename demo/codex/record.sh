#!/usr/bin/env bash
# Records the demo with OBS, as a fallback for a live demo that goes wrong.
#
#   demo/codex/record.sh [run.sh args]   # record the unattended run.sh demo
#   demo/codex/record.sh start           # start recording, for the voice demo
#   demo/codex/record.sh stop            # stop; prints the movie's path
#
# Needs OBS with Tools > WebSocket Server Settings > Enable turned on, and
# Screen Recording permission for OBS. Movies go where OBS's Output settings
# say (~/Movies by default).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
obs() { bun "$here/obs.ts" "$@"; }

ready() {
  if ! pgrep -xq obs; then
    open -a OBS
  fi
  # OBS answers "not ready" for a few seconds after it opens.
  for _ in $(seq 30); do
    obs setup >/dev/null 2>&1 && return
    sleep 1
  done
  obs setup # once more, to show why it failed
}

case "${1:-}" in
  start)
    ready
    obs start ;;
  stop)
    obs stop ;;
  *)
    ready
    obs start
    # Stop even when the demo fails, so the movie is finished and playable.
    trap 'obs stop' EXIT
    "$here/run.sh" "$@" ;;
esac
