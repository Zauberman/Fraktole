#!/bin/sh
# Fraktole deb post-install hook (electron-builder deb.afterInstall).
#
# The deb ships the raw binary at /opt/Fraktole/fraktole-desktop. Wrapping it
# with the environment-sanitizing launcher at /usr/bin/fraktole-desktop makes
# both the terminal command and the app-menu entry survive the GTK3/GTK4
# collision. Also drops stale update-alternatives links from older installs.
set -e

BIN=/usr/bin/fraktole-desktop
REAL=/opt/Fraktole/fraktole-desktop
LAUNCHER=/opt/Fraktole/launcher.sh
DESKTOP=/usr/share/applications/fraktole-desktop.desktop

if [ -x "$REAL" ] && [ -x "$LAUNCHER" ]; then
  update-alternatives --remove fraktole-desktop "$REAL" 2>/dev/null || true
  rm -f "$BIN"
  cat > "$BIN" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export FRAKTOLE_REAL_BIN="$REAL"
exec bash "$LAUNCHER" "\$@"
EOF
  chmod 755 "$BIN"

  if [ -f "$DESKTOP" ]; then
    sed -i "s|^Exec=.*|Exec=$BIN|" "$DESKTOP"
  fi
fi

update-desktop-database /usr/share/applications 2>/dev/null || true
exit 0
