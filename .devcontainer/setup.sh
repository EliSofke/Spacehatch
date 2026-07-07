#!/usr/bin/env bash
# postCreateCommand: prepare the codespace.
# Portable by design — copy .devcontainer/ into any target repo and it works;
# the backend install only runs when this is the service repo itself.
set -euo pipefail

cd "$(dirname "$0")/terminal-bridge"
npm install --omit=dev --no-audit --no-fund

if [ -f ../../backend/package.json ]; then
  (cd ../../backend && npm ci --no-audit --no-fund)
fi
