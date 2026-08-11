#!/usr/bin/env bash
# Builds the Electron app into release/linux-unpacked once per source change.
#
# The portable installer needs this unpacked tree; this gate makes a second
# build of the same cycle skip the redundant pnpm build + electron-builder
# pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

APP_ASAR="release/linux-unpacked/resources/app.asar"

stale() {
  [ -f "${APP_ASAR}" ] || return 0
  # source inputs newer than the last packaged asar → rebuild.
  # dist-electron/dist-renderer are outputs and deliberately not checked;
  # installer scripts don't reach the asar either.
  find src electron scripts/build-main.mjs build package.json vite.config.ts tsconfig.json \
    -type f -newer "${APP_ASAR}" | grep -q . && return 0
  return 1
}

if stale; then
  pnpm build >/dev/null
  pnpm exec electron-builder --linux dir >/dev/null
else
  echo "linux-unpacked is fresh — skipping build"
fi
