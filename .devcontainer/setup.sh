#!/usr/bin/env bash
# postCreateCommand: prepare the codespace (runs once at creation, headless).
# Fail loud: a broken install must surface in the creation log, not silently
# leave the terminal bridge unable to start.
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")/terminal-bridge" && pwd)"
cd "$BRIDGE_DIR"

echo "[setup] installing terminal-bridge dependencies in $BRIDGE_DIR"
npm install --omit=dev --no-audit --no-fund

# Verify the native module actually loads — the most common silent failure is
# node-pty compiling but not loading, which would 502 the forwarded port.
node -e "require('node-pty'); console.log('[setup] node-pty loads OK')"

# Backend deps only when this is the service repo itself (portable devcontainer).
if [ -f ../../backend/package.json ]; then
  echo "[setup] installing backend dependencies"
  (cd ../../backend && npm ci --no-audit --no-fund)
fi

echo "[setup] done"
