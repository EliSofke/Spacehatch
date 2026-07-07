#!/usr/bin/env bash
# postStartCommand: start the terminal bridge in the background.
# Idempotent: a second start replaces a stale instance.
set -euo pipefail

pkill -f "terminal-bridge/server.js" 2>/dev/null || true
cd "$(dirname "$0")/terminal-bridge"
nohup node server.js > /tmp/terminal-bridge.log 2>&1 &
echo "terminal bridge starting on port ${BRIDGE_PORT:-7681} (log: /tmp/terminal-bridge.log)"
