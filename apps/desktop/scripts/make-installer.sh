#!/usr/bin/env bash
# Builds the portable, self-contained Fraktole installer:
#
#   release/fraktole-install-<version>.sh        (single file, ~110MB)
#   release/fraktole-install-<version>.sh.sha256
#
# Copy the .sh to any Linux machine and run `bash fraktole-install.sh`.
# It embeds the built app as a tar.gz payload after an exit-0 marker, plus
# an inline launcher and icon — nothing is fetched and nothing outside the
# file is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
OUT="release/fraktole-install-${VERSION}.sh"
MARKER="__FRAKTOLE_PAYLOAD__"

echo "building the app (linux dir target)..."
pnpm build >/dev/null
pnpm exec electron-builder --linux dir >/dev/null

PAYLOAD="$(mktemp)"
trap 'rm -f "${PAYLOAD}"' EXIT
tar czf "${PAYLOAD}" -C release/linux-unpacked .

HEADER="$(mktemp)"
trap 'rm -f "${PAYLOAD}" "${HEADER}"' EXIT

cat > "${HEADER}" <<'GENEOF'
#!/usr/bin/env bash
# Fraktole @VERSION@ — self-contained installer.
#
#   bash fraktole-install.sh            install to ~/.local (no sudo)
#   bash fraktole-install.sh --uninstall
#
# Requirements: bash, tar, gzip, base64 (present on every Linux desktop).
# The app itself needs the usual Electron system libraries (libgtk-3,
# libnss3, libasound2) like any Electron application.
set -euo pipefail

VERSION="@VERSION@"
PREFIX="${HOME}/.local"
LIBDIR="${PREFIX}/lib/fraktole-desktop"
BIN="${PREFIX}/bin/fraktole-desktop"
APP_DIR="${PREFIX}/share/applications"
ICON_DIR="${PREFIX}/share/icons/hicolor/512x512/apps"
DESKTOP="${APP_DIR}/fraktole-desktop.desktop"
ICON="${ICON_DIR}/fraktole-desktop.png"
BASHRC="${HOME}/.bashrc"
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
  tail -c +$((PAYLOAD_OFFSET + ${#MARKER} + 2)) "${0}" | tar xz -C "${target}" || die "corrupt installer: payload extraction failed"
}

uninstall() {
  rm -rf "${LIBDIR}"
  rm -f "${BIN}" "${DESKTOP}" "${ICON}"
  if [ -f "${BASHRC}" ]; then
    sed -i '/^# fraktole$/d; /^export PATH="\$HOME\/.local\/bin:\$PATH"$/d' "${BASHRC}"
  fi
  update-desktop-database "${APP_DIR}" 2>/dev/null || true
  echo "fraktole ${VERSION} uninstalled"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

echo "installing Fraktole ${VERSION}..."
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
extract_payload "${TMP}"

mkdir -p "${LIBDIR}" "${PREFIX}/bin" "${APP_DIR}" "${ICON_DIR}"
rm -rf "${LIBDIR}"
cp -a "${TMP}/." "${LIBDIR}/"
chmod +x "${LIBDIR}/fraktole-desktop"

cat > "${LIBDIR}/launcher.sh" <<'LAUNCHER_EOF'
GENEOF

cat scripts/launcher.sh >> "${HEADER}"

cat >> "${HEADER}" <<'GENEOF'
LAUNCHER_EOF
chmod +x "${LIBDIR}/launcher.sh"

printf '%s' '__ICON_B64__' | base64 -d > "${ICON}"

cat > "${ICON_DIR}/../../index.theme" <<'THEME'
[Icon Theme]
Name=Hicolor
Directories=512x512/apps

[512x512/apps]
Size=512
Type=Directories
Context=Applications
THEME

cat > "${BIN}" <<EOF
#!/usr/bin/env bash
# Fraktole launcher — see launcher.sh for why.
set -euo pipefail
export FRAKTOLE_REAL_BIN="${LIBDIR}/fraktole-desktop"
exec bash "${LIBDIR}/launcher.sh" "\$@"
EOF
chmod +x "${BIN}"

cat > "${DESKTOP}" <<EOF
[Desktop Entry]
Type=Application
Name=Fraktole
Comment=Tiling command center for AI agents
Exec=${BIN}
Icon=fraktole-desktop
Terminal=false
Categories=Development;
StartupWMClass=Fraktole
StartupNotify=true
EOF

gtk-update-icon-cache "${PREFIX}/share/icons/hicolor" -f 2>/dev/null || true
update-desktop-database "${APP_DIR}" 2>/dev/null || true
if [ -f "${BASHRC}" ] && ! grep -qF '.local/bin' "${BASHRC}"; then
  printf '\n# fraktole\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "${BASHRC}"
  echo "added ~/.local/bin to PATH in ~/.bashrc (open a new shell)"
fi

echo
echo "installed:"
echo "  ${BIN}"
echo "  ${DESKTOP}"
echo
echo "launch from the app menu or run: fraktole-desktop"
echo "uninstall with: bash ${0} --uninstall"
exit 0
GENEOF

# fix the version placeholder (same length as @VERSION@ → offset unchanged)
sed -i "s|@VERSION@|${VERSION}|g" "${HEADER}"

# substitute the icon base64 (safe: A-Za-z0-9+/=)
ICON_B64="$(base64 -w0 build/icon.png)"
sed -i "s|__ICON_B64__|${ICON_B64}|" "${HEADER}"

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

echo
echo "portable installer:"
echo "  ${OUT}  ($(du -h "${OUT}" | cut -f1))"
echo "  ${OUT}.sha256"
echo
echo "copy it to any machine and run: bash ${OUT}"
