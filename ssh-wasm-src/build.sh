#!/usr/bin/env bash
# Build the canonical Go transport (dev-tunnels + grpc-go + x/crypto/ssh) into a
# GOOS=js WASM module and refresh wasm_exec.js. Expects `go` on PATH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../frontend-ssh-wasm"
mkdir -p "$OUT"
( cd "$HERE" && GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o "$OUT/spacehatch-ssh.wasm" . )
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"
echo "built $OUT/spacehatch-ssh.wasm ($(wc -c < "$OUT/spacehatch-ssh.wasm") bytes); wasm_exec.js refreshed"
