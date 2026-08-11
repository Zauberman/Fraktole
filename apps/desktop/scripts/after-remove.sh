#!/bin/sh
# Fraktole deb post-remove hook (electron-builder deb.afterRemove).
# Removes the launcher wrapper created by after-install.sh.
set -e

rm -f /usr/bin/fraktole-desktop
update-desktop-database /usr/share/applications 2>/dev/null || true
exit 0
