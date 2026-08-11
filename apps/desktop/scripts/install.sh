#!/usr/bin/env bash
# Fraktole install/uninstall — single source of truth for the ~/.local layout.
#
# Installs the app from its own directory. Expected layout (this is exactly
# what the installer payload and the repo root provide):
#
#   ./install.sh      this file
#   ./launcher.sh     env-sanitizing launcher (GTK3/GTK4 crash fix)
#   ./icon.png        app icon
#   ./app/...         electron linux-unpacked tree
#
# The same file runs verbatim from an extracted installer payload; it takes
# no arguments for install and handles --uninstall itself. Installs to:
#   ~/.local/lib/fraktole-desktop/      the app
#   ~/.local/bin/fraktole-desktop       sanitizing launcher
#   ~/.local/share/applications/        app menu entry
#   ~/.local/share/icons/hicolor/       app icon
# and adds ~/.local/bin to PATH in ~/.bashrc when missing.
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

die() {
  echo "fraktole: $*" >&2
  exit 1
}

uninstall() {
  rm -rf "${LIBDIR}"
  rm -f "${BIN}" "${DESKTOP}" "${ICON}"
  if [ -f "${BASHRC}" ]; then
    sed -i '/^# fraktole$/d; /^export PATH=.*# fraktole$/d' "${BASHRC}"
  fi
  update-desktop-database "${APP_DIR}" 2>/dev/null || true
  echo "fraktole ${VERSION} uninstalled"
}

install() {
  local source
  source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -x "${source}/app/fraktole-desktop" ] || die "no app payload in ${source}"

  echo "installing Fraktole ${VERSION}..."
  mkdir -p "${LIBDIR}" "${PREFIX}/bin" "${APP_DIR}" "${ICON_DIR}"
  rm -rf "${LIBDIR}"
  cp -a "${source}/app/." "${LIBDIR}/"
  chmod +x "${LIBDIR}/fraktole-desktop"

  cp "${source}/launcher.sh" "${LIBDIR}/launcher.sh"
  chmod +x "${LIBDIR}/launcher.sh"

  cp "${source}/icon.png" "${ICON}"

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
    printf '\n# fraktole\nexport PATH="$HOME/.local/bin:$PATH"  # fraktole\n' >> "${BASHRC}"
    echo "added ~/.local/bin to PATH in ~/.bashrc (open a new shell)"
  fi

  echo
  echo "installed:"
  echo "  ${BIN}"
  echo "  ${DESKTOP}"
  echo
  echo "launch from the app menu or run: fraktole-desktop"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

install
