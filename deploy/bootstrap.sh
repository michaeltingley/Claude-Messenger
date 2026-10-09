#!/usr/bin/env bash
# Claude Messenger — one-command host bootstrap.
#
# Takes a fresh Ubuntu 24.04 machine (VPS or home box) to a fully running,
# boot-persistent Claude Messenger host:
#
#   Beeper Desktop (headless under Xvfb, signed in to YOUR account)
#        ▲ localhost:23373
#   Claude Messenger (policy + audit + HTTP MCP on localhost:8484)
#        ▲ Tailscale (private tailnet; nothing on the public internet)
#   Claude clients (claude.ai, Claude Code, Claude Desktop)
#
# Interactive by design: you join the host to YOUR tailnet, then sign Beeper
# in from a browser. deploy/signin-surface.sh opens the login screen to your
# tailnet only, and this script closes it again once doctor is green. Run it
# in an SSH session and follow the prompts:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/michaeltingley/Claude-Messenger/main/deploy/bootstrap.sh)"
#
# Re-running is safe: each step skips work that is already done.
set -euo pipefail

# Under `curl ... | bash`, stdin is the script itself — every interactive
# prompt would eat script text. Rebind stdin to the terminal, or stop early
# with a clear message instead of corrupting midway.
if ! [ -t 0 ]; then
  if [ -e /dev/tty ]; then
    exec </dev/tty
  else
    printf 'This script is interactive (Tailscale login, Beeper sign-in, token paste). Run it with a terminal:\n' >&2
    printf '  bash -c "$(curl -fsSL https://raw.githubusercontent.com/michaeltingley/Claude-Messenger/main/deploy/bootstrap.sh)"\n' >&2
    exit 1
  fi
fi

REPO_URL="${CLAUDE_MESSENGER_REPO:-https://github.com/michaeltingley/Claude-Messenger.git}"
INSTALL_DIR="${CLAUDE_MESSENGER_HOME:-$HOME/claude-messenger}"
MCP_PORT="${CLAUDE_MESSENGER_MCP_PORT:-8484}"
SURFACE="$INSTALL_DIR/deploy/signin-surface.sh"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Run as a regular user with sudo access, not root (systemd user services need a real user)."
command -v sudo >/dev/null || die "sudo is required."

say "1/7 System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates openssl >/dev/null
ok "base packages"

say "2/7 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version)"

say "3/7 Tailscale (private network path to this host)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Follow the URL below to attach this machine to YOUR tailnet:"
  sudo tailscale up
fi
ok "tailscale up ($(tailscale ip -4 2>/dev/null | head -1 || echo 'ip pending'))"

# Before Beeper: the systemd units and the sign-in surface script ship in
# the repo, so the checkout must exist first.
say "4/7 Claude Messenger"
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi
cd "$INSTALL_DIR"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
ok "built $(node dist/cli/main.js --version)"

say "5/7 Beeper Desktop (headless, under Xvfb)"
# Deliberately NOT `beeper setup --server --install`. beeper/cli#21 is open and
# unanswered: on a legacy cloud-bridge account that path deleted every bridge
# connection (WhatsApp, Telegram, Google Messages) across ALL devices, and its
# chats API returned empty results. Beeper Desktop serves the identical Client
# API on the same port, so nothing above the provider seam changes.
MANAGED_BEEPER=1
if curl -fsS http://127.0.0.1:23373/v1/info >/dev/null 2>&1 &&
  [ ! -e "$HOME/.config/systemd/user/beeper-desktop.service" ]; then
  # A Beeper Desktop this script didn't install is already serving the API
  # (e.g. your own app on a spare laptop). A second, headless instance would
  # fight it for :23373 and register as another device, so leave it alone.
  MANAGED_BEEPER=0
  ok "Beeper Desktop already serving on http://127.0.0.1:23373 (yours; not managed here)"
else
  if [ ! -x /opt/beeper/squashfs-root/AppRun ]; then
    case "$(uname -m)" in
      aarch64|arm64) BEEPER_ARCH=arm64 ;;
      x86_64|amd64)  BEEPER_ARCH=x64 ;;
      *) die "unsupported architecture $(uname -m)" ;;
    esac

    sudo apt-get update -qq
    sudo apt-get install -y -qq xvfb xauth x11vnc novnc websockify libfuse2t64 \
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

  if ! curl -fsS http://127.0.0.1:23373/v1/info >/dev/null 2>&1; then
    bash "$SURFACE" up || warn "the sign-in screen is not on your tailnet; see the message above"
    echo "Sign in to Beeper there: your emailed code and recovery key go straight into the app."
    echo "Then make sure 'Beeper Desktop API' is switched on in Beeper's settings."
    read -rp "Press Enter once Beeper has finished syncing your accounts... " _

    # Waiting beats assuming: the API only answers once the app is actually up.
    for _ in $(seq 1 30); do
      curl -fsS http://127.0.0.1:23373/v1/info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
  curl -fsS http://127.0.0.1:23373/v1/info >/dev/null 2>&1 ||
    die "Beeper Desktop is not answering on 127.0.0.1:23373. Check 'systemctl --user status beeper-desktop' and that the Desktop API is switched on."
  ok "Beeper Desktop on http://127.0.0.1:23373"
fi

say "6/7 Configuration"
# Nobody else on this host may read this home: it holds .env (the Beeper
# token) and, on a managed host, Beeper's own data. Either bypasses the policy
# layer. See docs/SHARED-HOST.md, rule 1.
chmod go-rwx "$HOME"
if [ ! -f .env ]; then
  if [ "$MANAGED_BEEPER" -eq 1 ]; then
    # Minting needs the app's screen. `up` is idempotent and reprints the URL,
    # and it reopens the screen if an earlier run already closed it.
    bash "$SURFACE" up || warn "the sign-in screen is not on your tailnet; see the message above"
  fi
  echo "Claude Messenger needs an access token for Beeper Desktop's local API."
  echo "Mint one in Beeper: Settings -> Integrations -> '+' next to"
  echo "\"Approved connections\". (Never via the Beeper CLI: see beeper/cli#21.)"
  read -rsp "Paste Beeper access token: " BEEPER_TOKEN; echo
  MCP_TOKEN="$(openssl rand -hex 32)"
  # umask first: the file must never exist world-readable, even briefly.
  (
    umask 077
    cat > .env <<EOF
BEEPER_ACCESS_TOKEN=${BEEPER_TOKEN}
BEEPER_BASE_URL=http://127.0.0.1:23373
CLAUDE_MESSENGER_POLICY=${INSTALL_DIR}/policy.json
CLAUDE_MESSENGER_AUDIT_DIR=${INSTALL_DIR}/audit
CLAUDE_MESSENGER_STATE_DIR=${INSTALL_DIR}/state
CLAUDE_MESSENGER_MCP_TOKEN=${MCP_TOKEN}
EOF
  )
fi
[ -f policy.json ] || node dist/cli/main.js policy-init
node dist/cli/main.js doctor ||
  die "doctor failed. Fix the reported link and re-run this script. Any open Beeper sign-in screen stays open for that; close it with: $SURFACE down"
ok "doctor green (policy: read-only until you edit policy.json)"
if [ "$MANAGED_BEEPER" -eq 1 ]; then
  # The login screen exists only for the login, and doctor just proved the
  # login works. Refuse to report success while anything is still exposed.
  bash "$SURFACE" down || die "the Beeper sign-in screen is still exposed; close it before using this host"
  ok "sign-in surface closed"
fi

say "7/7 systemd service + tailnet exposure"
mkdir -p "$HOME/.config/systemd/user"
# __NODE__ must be the RESOLVED interpreter: /usr/bin/node only exists on
# apt installs; nvm/asdf setups would 203/EXEC with a hardcoded path.
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__PORT__|$MCP_PORT|g; s|__NODE__|$(command -v node)|g" \
  "$INSTALL_DIR/deploy/systemd/claude-messenger-mcp.service" > "$HOME/.config/systemd/user/claude-messenger-mcp.service"
systemctl --user daemon-reload
systemctl --user enable claude-messenger-mcp.service
# restart, not enable --now: re-runs are upgrades and must swap the process.
systemctl --user restart claude-messenger-mcp.service
sleep 1
curl -fsS "http://127.0.0.1:${MCP_PORT}/healthz" >/dev/null || die "MCP service failed to start — check: journalctl --user -u claude-messenger-mcp"
# HTTPS on the tailnet only; the MCP port itself stays on loopback.
sudo tailscale serve --bg "http://127.0.0.1:${MCP_PORT}" || warn "tailscale serve failed — you can still use http://<tailscale-ip>:${MCP_PORT} inside the tailnet via an SSH tunnel"
ok "claude-messenger-mcp.service running"

# `|| true` inside the substitution: a tailscaled hiccup at the very end
# must not (via pipefail) kill an otherwise-successful install.
MAGICDNS="$({ tailscale status --json 2>/dev/null || true; } | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const n=JSON.parse(d).Self.DNSName.replace(/\.$/,"");console.log(n||"<this-host>")}catch{console.log("<this-host>")}})')"
cat <<EOF

════════════════════════════════════════════════════════════════════
 Claude Messenger is hosted. Connect a Claude client from any device
 on your tailnet:

   URL:    https://${MAGICDNS}/mcp
   Token:  in ${INSTALL_DIR}/.env — print it with:
             grep CLAUDE_MESSENGER_MCP_TOKEN ${INSTALL_DIR}/.env

   Claude Code:
     claude mcp add claude-messenger --transport http https://${MAGICDNS}/mcp \\
       --header "Authorization: Bearer \$(grep CLAUDE_MESSENGER_MCP_TOKEN ${INSTALL_DIR}/.env | cut -d= -f2)"

 Policy is READ-ONLY until you edit ${INSTALL_DIR}/policy.json.
 Audit trail: ${INSTALL_DIR}/audit/
════════════════════════════════════════════════════════════════════
EOF
