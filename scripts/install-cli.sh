#!/usr/bin/env bash
# Builds the single-file bundles and installs `fraktole` onto your PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm bundle

BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"
cp dist/fraktole.mjs dist/fraktole-daemon.mjs "${BIN_DIR}/"
chmod +x "${BIN_DIR}/fraktole.mjs" "${BIN_DIR}/fraktole-daemon.mjs"
ln -sf "${BIN_DIR}/fraktole.mjs" "${BIN_DIR}/fraktole"

echo "installed:"
echo "  ${BIN_DIR}/fraktole            (run 'fraktole' anywhere)"
echo "  ${BIN_DIR}/fraktole-daemon.mjs (internal, spawned by 'fraktole start')"
