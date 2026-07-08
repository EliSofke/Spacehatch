#!/usr/bin/env bash
# Build the unmodified go-gh library into a GOOS=js WASM module (gh.wasm) and
# refresh wasm_exec.js from the active Go toolchain.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/home/claude/go/bin:$PATH"
export GOPATH="${GOPATH:-/home/claude/gopath}" GOCACHE="${GOCACHE:-/home/claude/.gocache}" GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"

OUT="$HERE/../frontend-gh-wasm"
mkdir -p "$OUT"

( cd "$HERE" && GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o "$OUT/gh.wasm" . )
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"

echo "built $OUT/gh.wasm ($(wc -c < "$OUT/gh.wasm") bytes); wasm_exec.js refreshed"
