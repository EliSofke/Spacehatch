#!/usr/bin/env bash
# postStartCommand: start the terminal bridge, fully detached, and confirm it
# is actually listening before returning. Runs on every codespace start.
#
# The 502 failure mode this guards against: the codespace's port 7681 is
# forwarded, but nothing listens on it because the bridge never came up. Here
# we (1) ensure deps exist, (2) start the bridge detached from the lifecycle
# shell via setsid+nohup so it survives, and (3) poll /healthz so a failure is
# written to the start log instead of only surfacing as a browser 502.
set -uo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")/terminal-bridge" && pwd)"
PORT="${BRIDGE_PORT:-7681}"
LOG="/tmp/spacehatch-bridge.log"
cd "$BRIDGE_DIR"

# Idempotent safety net: cover the case where postCreateCommand did not run or
# left an incomplete install (fresh restart, cache miss, etc.).
if ! node -e "require('node-pty')" >/dev/null 2>&1; then
  echo "[start] dependencies missing or unloadable — installing"
  npm install --omit=dev --no-audit --no-fund
fi

# Replace any stale instance so restarts are clean.
pkill -f "terminal-bridge/server.js" 2>/dev/null || true

echo "[start] launching bridge on :$PORT (log: $LOG)"
setsid nohup node server.js > "$LOG" 2>&1 < /dev/null &

# Readiness probe: surface a startup failure here rather than as a silent 502.
for _ in $(seq 1 20); do
  if curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
    echo "[start] bridge healthy on :$PORT"
    exit 0
  fi
  sleep 1
done

echo "[start] WARNING: bridge did not become healthy within 20s" >&2
echo "[start] --- last lines of $LOG ---" >&2
tail -n 30 "$LOG" >&2 || true
# Exit 0 so codespace start is not marked failed; the log carries the diagnosis.
exit 0
