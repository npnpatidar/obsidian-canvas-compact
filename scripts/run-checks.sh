#!/usr/bin/env bash
# Verification harness runner for the layout engines.
#
# The harnesses are plain node scripts that import the engine modules directly,
# so they are compiled to a temp dir with the same flags the old manual
# instructions in each file used. No Obsidian runtime is involved.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/canvas-compact-checks"
rm -rf "$OUT"

build() {
  local entry="$1" name="$2"
  # Only the Obsidian-free engine modules; main.ts/settings.ts need the app runtime.
  npx tsc "$entry" src/clean.ts src/dagcola.ts src/daglayout.ts src/pack.ts src/graph.ts src/Canvas.d.ts \
    --outDir "$OUT/$name" \
    --module commonjs --target es2020 --moduleResolution node \
    --skipLibCheck --esModuleInterop --strict
}

echo "▸ building harnesses"
build scripts/clean.check.ts clean
build scripts/dagcola.check.ts dagcola

echo
echo "▸ clean layout"
NODE_PATH="$PWD/node_modules" node "$OUT/clean/scripts/clean.check.js"

echo
echo "▸ dagcola layout"
NODE_PATH="$PWD/node_modules" node "$OUT/dagcola/scripts/dagcola.check.js"

echo
echo "✓ all harnesses passed"
