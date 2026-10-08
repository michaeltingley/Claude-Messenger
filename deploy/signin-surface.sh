#!/usr/bin/env bash
# Claude Messenger — Beeper Desktop's one-time sign-in surface.
#
# Beeper's login (emailed code + recovery key) needs a real screen. On a
# headless host that screen is the Xvfb display, viewed through x11vnc +
# noVNC (both loopback-only) and published ONLY to the user's own tailnet by
# `tailscale serve`. The user types the code and key straight into the app;
# nothing is relayed through a chat transcript.
#
# A VNC view of a signed-in Beeper is equivalent to holding the account, so
# the surface is DOWN by default and up only for a login:
#
#   deploy/signin-surface.sh up      # start it, publish it to the tailnet, print the URL
#   deploy/signin-surface.sh down    # unpublish + stop; exits non-zero if anything stays exposed
#   deploy/signin-surface.sh status  # exit 0 if exposed in any way, 1 if fully down
#
# `up` starts the units but never enables them, so a reboot always closes the
# surface. This script is the one place that opens or closes it: bootstrap.sh,
# the runbook, and the re-auth procedure in docs/DEPLOY.md all go through it.
set -euo pipefail

PORT=8443
BACKEND="http://127.0.0.1:6080"
UNITS=(x11vnc.service novnc.service)
SELF="$(basename "$0")"

err() { printf '✗ %s\n' "$*" >&2; }

unit_installed() { systemctl --user cat "$1" >/dev/null 2>&1; }

# Exit 0 if `tailscale serve` publishes anything on $PORT, 1 if not, and 2 if
# it can't tell.
#
# The JSON serve config names the port as a TCP key ("8443") and as a web
# host suffix ("<host>:8443"). Reading the config may need root, so a failed
# plain read is retried with sudo. An unreadable config means "can't tell",
# which callers treat as exposed (fail closed). Off the tailnet, nothing is
# reachable, so that counts as not published.
published() {
  command -v tailscale >/dev/null || return 1
  tailscale status >/dev/null 2>&1 || return 1
  local cfg
  cfg="$(tailscale serve status --json 2>/dev/null)" ||
    cfg="$(sudo tailscale serve status --json 2>/dev/null)" ||
    return 2
  printf '%s' "$cfg" | grep -Eq "[\":]${PORT}\""
}

tailnet_url() {
  local name=""
  if command -v node >/dev/null; then
    name="$(tailscale status --json 2>/dev/null | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try { console.log(JSON.parse(d).Self.DNSName.replace(/\.$/, "")); } catch {}
      });' || true)"
  fi
  printf 'https://%s:%s/vnc.html\n' "${name:-<this-host>.<tailnet>.ts.net}" "$PORT"
}

status() {
  local exposed=1 unit rc=0
  published || rc=$?
  case "$rc" in
    0) echo "published to the tailnet on :${PORT}"; exposed=0 ;;
    2) echo "tailnet serve config unreadable; assuming :${PORT} is published"; exposed=0 ;;
  esac
  for unit in "${UNITS[@]}"; do
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      echo "${unit}: running"
      exposed=0
    fi
    if systemctl --user is-enabled --quiet "$unit" 2>/dev/null; then
      echo "${unit}: enabled at boot"
      exposed=0
    fi
  done
  if [ "$exposed" -eq 1 ]; then echo "sign-in surface: down"; fi
  return "$exposed"
}

up() {
  if ! tailscale status >/dev/null 2>&1; then
    err "this host is not on a tailnet yet; run: sudo tailscale up"
    return 1
  fi
  local unit
  for unit in "${UNITS[@]}"; do
    if ! unit_installed "$unit"; then
      err "${unit} is not installed; run deploy/bootstrap.sh first"
      return 1
    fi
  done
  systemctl --user start "${UNITS[@]}"
  if ! sudo tailscale serve --bg --https "$PORT" "$BACKEND" >/dev/null; then
    err "could not publish the sign-in screen to the tailnet."
    err "Alternative: ssh -L 6080:127.0.0.1:6080 <this-host>, then open http://127.0.0.1:6080/vnc.html"
    return 1
  fi
  echo "Beeper sign-in is open, to your tailnet only, at:"
  echo "  $(tailnet_url)"
  echo "Close it as soon as you're signed in: ${SELF} down"
}

down() {
  local unit rc=0
  published || rc=$?
  # Published, or can't tell: unpublish either way.
  if [ "$rc" -ne 1 ]; then
    sudo tailscale serve --https "$PORT" off >/dev/null 2>&1 || true
  fi
  for unit in "${UNITS[@]}"; do
    if unit_installed "$unit"; then
      # disable as well as stop: hosts provisioned before this script existed
      # enabled the surface at boot.
      systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    fi
  done
  # Fail closed: verify the end state instead of trusting the commands above.
  if status >/dev/null; then
    err "the Beeper sign-in surface is STILL exposed:"
    status >&2 || true
    err "close it by hand: sudo tailscale serve --https ${PORT} off; systemctl --user disable --now ${UNITS[*]}"
    return 1
  fi
  echo "sign-in surface: down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *)
    echo "usage: ${SELF} up|down|status" >&2
    exit 2
    ;;
esac
