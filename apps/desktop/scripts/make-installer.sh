#!/usr/bin/env bash
# Builds the portable, self-contained Fraktole installer:
#
#   release/fraktole-install-<version>.sh        (single file, ~110MB)
#   release/fraktole-install-<version>.sh.sha256
#
# Copy the .sh to any Linux machine and run `bash fraktole-install.sh`.
# It embeds the built app as a tar.gz payload after an exit-0 marker; the
# payload layout matches what scripts/install.sh expects:
#
#   install.sh     canonical install/uninstall logic (first member: the
#                  --uninstall path streams only this entry out of the tar)
#   launcher.sh    env-sanitizing launcher (GTK3/GTK4 crash fix)
#   icon.png       app icon
#   app/...        electron linux-unpacked tree
#
# The header is deliberately thin: version, marker, offset, extraction.
# Everything else lives in install.sh, shared by every install path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
OUT="release/fraktole-install-${VERSION}.sh"
MARKER="__FRAKTOLE_PAYLOAD__"

echo "building the app (linux dir target)..."
bash scripts/ensure-unpacked.sh

STAGE="$(mktemp -d)"
HEADER="$(mktemp)"
PAYLOAD="$(mktemp)"
trap 'rm -rf "${STAGE}" "${HEADER}" "${PAYLOAD}"' EXIT

# stage the payload; install.sh must be the first member so --uninstall can
# stream it out without decompressing the 110MB app
cp scripts/install.sh "${STAGE}/install.sh"
cp scripts/launcher.sh "${STAGE}/launcher.sh"
cp build/icon.png "${STAGE}/icon.png"
mkdir -p "${STAGE}/app"
cp -a release/linux-unpacked/. "${STAGE}/app/"

# fix the version placeholder in the payload copy (the repo file keeps it)
sed -i "s|@VERSION@|${VERSION}|g" "${STAGE}/install.sh"

tar czf "${PAYLOAD}" -C "${STAGE}" install.sh launcher.sh icon.png app

cat > "${HEADER}" <<'GENEOF'
#!/usr/bin/env bash
# Fraktole @VERSION@ — self-contained installer.
#
#   bash fraktole-install.sh            install to ~/.local (no sudo)
#   bash fraktole-install.sh --uninstall
#
# Requirements: bash, tar, gzip (present on every Linux desktop). The app
# itself needs the usual Electron system libraries (libgtk-3, libnss3,
# libasound2) like any Electron application.
set -euo pipefail

VERSION="@VERSION@"
MARKER="__FRAKTOLE_PAYLOAD__"
PAYLOAD_OFFSET=@@@@@@@@@@@@@@@@@@@@
# the offset is emitted zero-padded (fixed width); force base-10, bash would
# otherwise read the leading zeros as octal
PAYLOAD_OFFSET=$((10#${PAYLOAD_OFFSET}))

die() {
  echo "fraktole: $*" >&2
  exit 1
}

extract_payload() {
  local target="$1"
  local sanity
  sanity="$(dd if="${0}" bs=1 skip="${PAYLOAD_OFFSET}" count=8 2>/dev/null)"
  [ "${sanity}" = "$(printf '%s' "${MARKER}" | head -c 8)" ] || die "corrupt installer: payload marker missing"
  # tail -c +K is 1-indexed: payload (gzip) starts at marker + its newline,
  # so K = PAYLOAD_OFFSET + len(MARKER) + 1 (newline) + 1 (1-based)
  tail -c +$((PAYLOAD_OFFSET + ${#MARKER} + 2)) "${0}" | tar xz -C "${target}" || die "corrupt installer: payload extraction failed"
}

if [ "${1:-}" = "--uninstall" ]; then
  # stream install.sh out of the payload without extracting the app; it is
  # the first tar member so only a few KB are decompressed
  tail -c +$((PAYLOAD_OFFSET + ${#MARKER} + 2)) "${0}" | tar xzO install.sh | bash -s -- --uninstall
  exit $?
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
extract_payload "${TMP}"

bash "${TMP}/install.sh"

echo
echo "uninstall with: bash ${0} --uninstall"
exit 0
GENEOF

# fix the version placeholder in the header
sed -i "s|@VERSION@|${VERSION}|g" "${HEADER}"

# the payload starts right after the marker line; record the byte offset as
# a zero-padded number. The placeholder is exactly 20 chars wide so the
# substitution never shifts the offset it records.
HEADER_SIZE="$(wc -c < "${HEADER}")"
sed -i "s|PAYLOAD_OFFSET=@@@@@@@@@@@@@@@@@@@@|PAYLOAD_OFFSET=$(printf '%020d' "${HEADER_SIZE}")|" "${HEADER}"

mkdir -p release
{
  cat "${HEADER}"
  printf '%s\n' "${MARKER}"
  cat "${PAYLOAD}"
} > "${OUT}"
chmod +x "${OUT}"

sha256sum "${OUT}" > "${OUT}.sha256"

# prune artifacts of other versions: release/ otherwise accumulates ~225MB
# per build (AppImage + installer) forever. linux-unpacked is kept — it is
# the freshness input of ensure-unpacked.sh.
PRUNED="$(find release -maxdepth 1 \( -name 'Fraktole-*.AppImage' -o -name 'fraktole-install-*.sh*' \) \
  ! -name "Fraktole-${VERSION}-*" ! -name "fraktole-install-${VERSION}.sh*" -print -delete | wc -l)"
if [ "${PRUNED}" -gt 0 ]; then
  echo "pruned ${PRUNED} artifact(s) of other versions from release/"
fi

echo
echo "portable installer:"
echo "  ${OUT}  ($(du -h "${OUT}" | cut -f1))"
echo "  ${OUT}.sha256"
echo
echo "verify with: sha256sum -c ${OUT}.sha256"
echo "copy it to any machine and run: bash ${OUT}"
