#!/usr/bin/env bash
# Claude Messenger — one-command host bootstrap.
#
# Takes a fresh Ubuntu 22.04/24.04 machine (VPS or home box) to a fully
# running, boot-persistent Claude Messenger host:
#
#   Beeper Server (headless, logged into YOUR account)
#        ▲ localhost:23373
#   Claude Messenger (policy + audit + HTTP MCP on localhost:8484)
#        ▲ Tailscale (private tailnet; nothing on the public internet)
#   Claude clients (claude.ai, Claude Code, Claude Desktop)
#
# Interactive by design: Beeper emails YOU a login code, and E2EE unlock
# needs YOUR recovery key. Run it in an SSH session and follow the prompts:
#
#   curl -fsSL https://raw.githubusercontent.com/michaeltingley/Claude-Messenger/main/deploy/bootstrap.sh | bash
#
# Re-running is safe: each step skips work that is already done.
set -euo pipefail

REPO_URL="${CLAUDE_MESSENGER_REPO:-https://github.com/michaeltingley/Claude-Messenger.git}"
INSTALL_DIR="${CLAUDE_MESSENGER_HOME:-$HOME/claude-messenger}"
MCP_PORT="${CLAUDE_MESSENGER_MCP_PORT:-8484}"

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

say "4/7 Beeper Server (headless, official)"
if ! command -v beeper >/dev/null; then
  sudo npm install -g beeper-cli >/dev/null
fi
if ! curl -fsS http://127.0.0.1:23373/v1/info >/dev/null 2>&1; then
  echo "Logging into your Beeper account — you'll be emailed a code. NOTE: Beeper Server"
  echo "is beta (staging/nightly artifacts); if this step misbehaves, see DEPLOY.md's"
  echo "fallback (Beeper Desktop + Remote Access on an always-on machine)."
  read -rp "Beeper account email: " BEEPER_EMAIL
  beeper setup --server --install --email "$BEEPER_EMAIL"
  echo "Unlock E2EE so the server can read your encrypted history:"
  beeper verify recovery-key
  beeper doctor || warn "beeper doctor reported issues — continuing; re-run it after setup"
  beeper targets enable
fi
sudo loginctl enable-linger "$USER"
ok "Beeper Server on http://127.0.0.1:23373"

say "5/7 Claude Messenger"
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi
cd "$INSTALL_DIR"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
ok "built $(node dist/cli/main.js --version)"

say "6/7 Configuration"
if [ ! -f .env ]; then
  echo "Claude Messenger needs a Beeper access token for the LOCAL server."
  echo "Mint one with the Beeper CLI (it prints a bearer token for this target),"
  echo "e.g. 'beeper token create' on current CLI builds — see 'beeper --help' if"
  echo "the subcommand differs on your version."
  read -rsp "Paste Beeper access token: " BEEPER_TOKEN; echo
  MCP_TOKEN="$(openssl rand -hex 32)"
  cat > .env <<EOF
BEEPER_ACCESS_TOKEN=${BEEPER_TOKEN}
BEEPER_BASE_URL=http://127.0.0.1:23373
CLAUDE_MESSENGER_POLICY=${INSTALL_DIR}/policy.json
CLAUDE_MESSENGER_AUDIT_DIR=${INSTALL_DIR}/audit
CLAUDE_MESSENGER_STATE_DIR=${INSTALL_DIR}/state
CLAUDE_MESSENGER_MCP_TOKEN=${MCP_TOKEN}
EOF
  chmod 600 .env
fi
[ -f policy.json ] || node dist/cli/main.js policy-init
node dist/cli/main.js doctor || die "doctor failed — fix the reported link and re-run this script"
ok "doctor green (policy: read-only until you edit policy.json)"

say "7/7 systemd service + tailnet exposure"
mkdir -p "$HOME/.config/systemd/user"
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__PORT__|$MCP_PORT|g" \
  "$INSTALL_DIR/deploy/claude-messenger-mcp.service" > "$HOME/.config/systemd/user/claude-messenger-mcp.service"
systemctl --user daemon-reload
systemctl --user enable --now claude-messenger-mcp.service
sleep 1
curl -fsS "http://127.0.0.1:${MCP_PORT}/healthz" >/dev/null || die "MCP service failed to start — check: journalctl --user -u claude-messenger-mcp"
# HTTPS on the tailnet only; the MCP port itself stays on loopback.
sudo tailscale serve --bg "http://127.0.0.1:${MCP_PORT}" || warn "tailscale serve failed — you can still use http://<tailscale-ip>:${MCP_PORT} inside the tailnet via an SSH tunnel"
ok "claude-messenger-mcp.service running"

MAGICDNS="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{console.log("<this-host>")}})')"
cat <<EOF

════════════════════════════════════════════════════════════════════
 Claude Messenger is hosted. Connect a Claude client from any device
 on your tailnet:

   URL:    https://${MAGICDNS}/mcp
   Header: Authorization: Bearer $(grep CLAUDE_MESSENGER_MCP_TOKEN "$INSTALL_DIR/.env" | cut -d= -f2)

   Claude Code:
     claude mcp add claude-messenger --transport http https://${MAGICDNS}/mcp \\
       --header "Authorization: Bearer <token above>"

 Policy is READ-ONLY until you edit ${INSTALL_DIR}/policy.json.
 Audit trail: ${INSTALL_DIR}/audit/
════════════════════════════════════════════════════════════════════
EOF
