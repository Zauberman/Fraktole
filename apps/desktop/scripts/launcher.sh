#!/usr/bin/env bash
# Fraktole launcher.
#
# Electron 36 (Chromium 136) dlopens both libgtk-3 and libgtk-4; libgtk-4
# aborts the process when any GTK3 module is also loaded into it. Desktop
# sessions inject GTK3 modules (xapp-gtk3-module, gail, ibus im-module)
# through GTK_MODULES / GTK3_MODULES / GTK_IM_MODULE / GTK_PATH etc., which
# is why clearing a couple of variables is never enough.
#
# The fix: launch the app with a curated environment. Agent CLIs launched in
# tiles keep their API keys, ssh-agent and proxy settings; nothing GTK ever
# leaks in. Harmless on desktops without the problem.
set -euo pipefail

REAL="${FRAKTOLE_REAL_BIN:-}"
if [ -z "$REAL" ]; then
  REAL="${1:-}"
  shift 2>/dev/null || true
fi
if [ -z "$REAL" ]; then
  echo "fraktole: no binary given (set FRAKTOLE_REAL_BIN or pass the path)" >&2
  exit 1
fi

# Locale variables: keep every LC_* / LANGUAGE entry.
locales=()
for name in $(env | sed -n 's/^\(LC_[A-Z_]*\|LANG\|LANGUAGE\)=.*/\1/p'); do
  locales+=("$name=${!name}")
done

# Proxy variables: keep any *_proxy / NO_PROXY entry.
proxies=()
for name in $(env | sed -n 's/^\([A-Z_]*_PROXY\|NO_PROXY\|no_proxy\)=.*/\1/p' | sort -u); do
  proxies+=("$name=${!name}")
done

# Fraktole variables: the reviewer harness reads its provider key through
# FRAKTOLE_* env names (settings.reviewer.apiKeyEnv) — keep every one.
fraktole_vars=()
for name in $(env | sed -n 's/^\(FRAKTOLE_[A-Z0-9_]*\)=.*/\1/p' | sort -u); do
  fraktole_vars+=("$name=${!name}")
done

# Already running? Tell the first instance to come forward and exit right
# here. Launching Electron anyway would create a doomed second instance —
# its zygote children outlive the quick quit and accumulate as orphans.
# (Only matches a bare main process: args-bearing launches fall through to
# Electron's own second-instance handling.)
EXISTING="$(pgrep -f 'lib/fraktole-desktop/fraktole-desktop$' 2>/dev/null | head -n1 || true)"
if [ -n "${EXISTING}" ]; then
  kill -USR2 "${EXISTING}" 2>/dev/null || true
  exit 0
fi

# XDG_CURRENT_DESKTOP is deliberately NOT passed: Chromium reads it and
# enables GNOME-specific GTK4 integration (e.g. zorin:GNOME), which collides
# with GTK3 modules injected by the session.
exec env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  USER="$USER" \
  LOGNAME="$LOGNAME" \
  SHELL="$SHELL" \
  TERM="$TERM" \
  COLORTERM="$COLORTERM" \
  TZ="${TZ:-}" \
  "${locales[@]}" \
  DISPLAY="${DISPLAY:-}" \
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
  XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-}" \
  DESKTOP_STARTUP_ID="${DESKTOP_STARTUP_ID:-}" \
  XDG_ACTIVATION_TOKEN="${XDG_ACTIVATION_TOKEN:-}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
  XAUTHORITY="${XAUTHORITY:-}" \
  SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}" \
  SSH_AGENT_PID="${SSH_AGENT_PID:-}" \
  GPG_AGENT_INFO="${GPG_AGENT_INFO:-}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}" \
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-}" \
  GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  EDITOR="${EDITOR:-}" \
  VISUAL="${VISUAL:-}" \
  PAGER="${PAGER:-}" \
  "${fraktole_vars[@]}" \
  "${proxies[@]}" \
  "$REAL" "$@"
