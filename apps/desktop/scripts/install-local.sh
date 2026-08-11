#!/usr/bin/env bash
# Fraktole desktop — seamless local install (no sudo).
#
#   ./scripts/install-local.sh          build + install
#   ./scripts/install-local.sh --uninstall
#
# Installs to:
#   ~/.local/lib/fraktole-desktop/      the app (electron linux-unpacked)
#   ~/.local/bin/fraktole-desktop       sanitizing launcher (GTK crash fix)
#   ~/.local/share/applications/        app menu entry
#   ~/.local/share/icons/hicolor/       app icon
# and adds ~/.local/bin to PATH in ~/.bashrc when missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${HOME}/.local"
LIBDIR="${PREFIX}/lib/fraktole-desktop"
BIN="${PREFIX}/bin/fraktole-desktop"
APP_DIR="${PREFIX}/share/applications"
ICON_DIR="${PREFIX}/share/icons/hicolor/512x512/apps"
DESKTOP="${APP_DIR}/fraktole-desktop.desktop"
ICON="${ICON_DIR}/fraktole-desktop.png"
BASHRC="${HOME}/.bashrc"

uninstall() {
  rm -rf "${LIBDIR}"
  rm -f "${BIN}" "${DESKTOP}" "${ICON}"
  if [ -f "${BASHRC}" ]; then
    sed -i '/^# fraktole$/d; /^export PATH="\$HOME\/.local\/bin:\$PATH"$/d' "${BASHRC}"
  fi
  update-desktop-database "${APP_DIR}" 2>/dev/null || true
  echo "fraktole-desktop uninstalled"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

echo "building fraktole-desktop..."
(cd "${ROOT}" && pnpm build >/dev/null && pnpm exec electron-builder --linux dir >/dev/null)

echo "installing to ${PREFIX}..."
mkdir -p "${LIBDIR}" "${PREFIX}/bin" "${APP_DIR}" "${ICON_DIR}"
rm -rf "${LIBDIR}"
cp -a "${ROOT}/release/linux-unpacked" "${LIBDIR}"
chmod +x "${LIBDIR}/fraktole-desktop"

cp "${ROOT}/build/icon.png" "${ICON}"
cat > "${ICON_DIR}/../../index.theme" <<'THEME'
[Icon Theme]
Name=Hicolor
Directories=512x512/apps

[512x512/apps]
Size=512
Type=Directories
Context=Applications
THEME
cp "${ROOT}/scripts/launcher.sh" "${LIBDIR}/launcher.sh"
chmod +x "${LIBDIR}/launcher.sh"

cat > "${BIN}" <<EOF
#!/usr/bin/env bash
# Fraktole launcher — see apps/desktop/scripts/launcher.sh for why.
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
echo "uninstall with: ${BASH_SOURCE[0]} --uninstall"
