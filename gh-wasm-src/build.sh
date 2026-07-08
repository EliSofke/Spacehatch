#!/usr/bin/env bash
# Build the unmodified go-gh library into a GOOS=js WASM module (gh.wasm) and
# refresh wasm_exec.js from the active Go toolchain. Environment-agnostic:
# expects `go` on PATH (locally: export it; in CI: actions/setup-go). GOPATH /
# GOCACHE are left to the caller / Go defaults so this runs unchanged in CI.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../frontend-gh-wasm"
mkdir -p "$OUT"

( cd "$HERE" && GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o "$OUT/gh.wasm" . )
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"

echo "built $OUT/gh.wasm ($(wc -c < "$OUT/gh.wasm") bytes); wasm_exec.js refreshed"
