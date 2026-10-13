#!/usr/bin/env bash
# Claude Messenger — one-command host bootstrap.
#
# Takes a fresh Ubuntu machine (VPS or home box) to a fully running,
# boot-persistent Claude Messenger host:
#
#   Beeper Desktop (headless under Xvfb, signed in to YOUR account)
#        ▲ localhost:23373
#   Claude Messenger (policy + audit + HTTP MCP on localhost:8484)
#        ▲ Tailscale (private tailnet; nothing on the public internet)
#   Claude clients (claude.ai, Claude Code, Claude Desktop)
#
# It never prompts, so a Claude session on the host can run it, and so can
# you over SSH:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/michaeltingley/Claude-Messenger/main/deploy/bootstrap.sh)"
#
# Your steps happen elsewhere, and the script waits for them: open the
# Tailscale login link it prints (first run only), then sign in to Beeper
# and approve Claude Messenger in Beeper's own window, which
# deploy/configure.sh opens to your tailnet through deploy/signin-surface.sh
# and closes again.
#
# Re-running is safe: each step skips work that is already done.
set -euo pipefail

REPO_URL="${CLAUDE_MESSENGER_REPO:-https://github.com/michaeltingley/Claude-Messenger.git}"
INSTALL_DIR="${CLAUDE_MESSENGER_HOME:-$HOME/claude-messenger}"
BEEPER_URL="${BEEPER_BASE_URL:-http://127.0.0.1:23373}"
# apt must never stop to ask: with no terminal, a debconf or needrestart
# prompt waits forever. sudo resets the environment, so these go on each
# sudo command line.
NONINTERACTIVE=(DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a)

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Beeper Desktop is up once it answers, signed in or not, and even with its
# Desktop API switched off: then every route says 404 "disabled", and the
# person switches it on in Beeper's window while configure.sh waits.
beeper_answers() {
  curl -fsS "$BEEPER_URL/v1/info" >/dev/null 2>&1 ||
    curl -sS "$BEEPER_URL/v1/info" 2>/dev/null | grep -Eq '"code" *: *"disabled"'
}

[ "$(id -u)" -eq 0 ] && die "Run as a regular user with sudo access, not root (systemd user services need a real user)."
command -v sudo >/dev/null || die "sudo is required."

say "1/6 System packages"
sudo "${NONINTERACTIVE[@]}" apt-get update -qq
sudo "${NONINTERACTIVE[@]}" apt-get install -y -qq curl git ca-certificates openssl >/dev/null
ok "base packages"

say "2/6 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo "${NONINTERACTIVE[@]}" bash - >/dev/null
  sudo "${NONINTERACTIVE[@]}" apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version)"

say "3/6 Tailscale (private network path to this host)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sudo "${NONINTERACTIVE[@]}" sh
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Open the login link below to add this machine to YOUR tailnet; this waits until you do:"
  sudo tailscale up
fi
ok "tailscale up ($(tailscale ip -4 2>/dev/null | head -1 || echo 'ip pending'))"

# Before Beeper: the systemd units and the sign-in surface script ship in
# the repo, so the checkout must exist first.
say "4/6 Claude Messenger"
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi
cd "$INSTALL_DIR"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
ok "built $(node dist/cli/main.js --version)"

say "5/6 Beeper Desktop (headless, under Xvfb)"
# Deliberately NOT `beeper setup --server --install`. beeper/cli#21 is open and
# unanswered: on a legacy cloud-bridge account that path deleted every bridge
# connection (WhatsApp, Telegram, Google Messages) across ALL devices, and its
# chats API returned empty results. Beeper Desktop serves the identical Client
# API on the same port, so nothing above the provider seam changes.
if beeper_answers && [ ! -e "$HOME/.config/systemd/user/beeper-desktop.service" ]; then
  # A Beeper Desktop this script didn't install is already serving the API
  # (e.g. your own app on a spare laptop). A second, headless instance would
  # fight it for :23373 and register as another device, so leave it alone.
  ok "Beeper Desktop already serving on $BEEPER_URL (yours; not managed here)"
else
  if [ ! -x /opt/beeper/squashfs-root/AppRun ]; then
    case "$(uname -m)" in
      aarch64|arm64) BEEPER_ARCH=arm64 ;;
      x86_64|amd64)  BEEPER_ARCH=x64 ;;
      *) die "unsupported architecture $(uname -m)" ;;
    esac

    sudo "${NONINTERACTIVE[@]}" apt-get update -qq
    sudo "${NONINTERACTIVE[@]}" apt-get install -y -qq xvfb xauth x11vnc novnc websockify libfuse2t64 \
      libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation

    # Extracted rather than run as an AppImage so systemd needs no FUSE.
    sudo mkdir -p /opt/beeper && sudo chown "$USER" /opt/beeper
    curl -fsSL -o /opt/beeper/Beeper.AppImage \
      "https://api.beeper.com/desktop/download/linux/${BEEPER_ARCH}/stable/com.automattic.beeper.desktop"
    chmod +x /opt/beeper/Beeper.AppImage
    (cd /opt/beeper && ./Beeper.AppImage --appimage-extract >/dev/null)
  fi

  # Beeper keeps your account's keys and history under this home, and its
  # login token works as an API token too: nobody else on this host may read
  # it. See docs/SHARED-HOST.md, rule 1.
  chmod go-rwx "$HOME"
  # Units come from deploy/systemd/, the single source shared with
  # cloud-init.yaml. Reinstalling them on every run is how upgrades land.
  mkdir -p "$HOME/.config/systemd/user"
  for unit in xvfb beeper-desktop x11vnc novnc; do
    install -m 644 "$INSTALL_DIR/deploy/systemd/$unit.service" "$HOME/.config/systemd/user/$unit.service"
  done
  sudo loginctl enable-linger "$USER"
  systemctl --user daemon-reload
  # Only the display and the app run at boot. The sign-in surface (x11vnc +
  # noVNC) is opened and closed by signin-surface.sh and never enabled.
  systemctl --user enable --now xvfb.service beeper-desktop.service

  # Signing in, and switching the Desktop API on if it is off, are part of
  # the approval in the next step.
  for _ in $(seq 1 60); do
    beeper_answers && break
    sleep 2
  done
  beeper_answers ||
    die "Beeper Desktop is not answering on $BEEPER_URL. Check 'systemctl --user status beeper-desktop'."
  ok "Beeper Desktop on $BEEPER_URL"
fi

say "6/6 Connect to Beeper and start the MCP service"
# exec: this process becomes configure.sh, so stopping bootstrap stops it
# too, and configure's own traps close the sign-in screen on the way out.
exec bash "$INSTALL_DIR/deploy/configure.sh"
