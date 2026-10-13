#!/usr/bin/env bash
# Claude Messenger — connect this install to Beeper and start its MCP service.
#
# The last step of deploy/bootstrap.sh, and safe to re-run on its own:
#
#   deploy/configure.sh              # finish or repair an install; restarts the service
#   deploy/configure.sh --reconnect  # get a new Beeper token, e.g. after Beeper was signed out
#
# It never prompts, so a Claude session can run it without a terminal. The
# person's only steps happen in Beeper's own window: signing in, and
# approving Claude Messenger's access. The token then goes from Beeper
# straight into .env (`claude-messenger connect`), so nobody types it and no
# transcript holds it. When Beeper runs headless on this host, its window is
# reachable only through the sign-in surface: this opens it for the approval
# and closes it again before it exits, however it exits.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_PORT="${CLAUDE_MESSENGER_MCP_PORT:-8484}"
BEEPER_URL="${BEEPER_BASE_URL:-http://127.0.0.1:23373}"
# A tailnet that has not allowed Tailscale Serve makes `tailscale serve` wait
# for someone to allow it; past this many seconds, stop waiting.
SERVE_TIMEOUT="${CLAUDE_MESSENGER_SERVE_TIMEOUT:-20}"
# How long the person has to sign in to Beeper and approve.
APPROVAL_MINUTES=60
SURFACE="$INSTALL_DIR/deploy/signin-surface.sh"
UNIT_DIR="$HOME/.config/systemd/user"
SELF="$(basename "$0")"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

RECONNECT=0
case "${1:-}" in
  "") ;;
  --reconnect) RECONNECT=1 ;;
  *) echo "usage: ${SELF} [--reconnect]" >&2; exit 2 ;;
esac

SURFACE_OPEN=0
# Close the sign-in surface if this run opened it. `down` verifies the end
# state, so this fails if anything is left exposed.
close_surface() {
  [ "$SURFACE_OPEN" -eq 1 ] || return 0
  SURFACE_OPEN=0
  bash "$SURFACE" down
}
trap 'close_surface || warn "the Beeper sign-in surface may still be exposed; close it: $SURFACE down"' EXIT
trap 'exit 130' INT TERM HUP

cd "$INSTALL_DIR"
[ -f dist/cli/main.js ] || die "Claude Messenger is not built in $INSTALL_DIR; run deploy/bootstrap.sh first."
cli() { node dist/cli/main.js "$@"; }

say "Configuration"
# Nobody else on this host may read this home: it holds .env (the Beeper
# token) and, on a managed host, Beeper's own data. Either bypasses the policy
# layer. See docs/SHARED-HOST.md, rule 1.
chmod go-rwx "$HOME"
if [ ! -f .env ]; then
  # umask first: the file must never exist world-readable, even briefly. The
  # Beeper token is added by `connect`, below.
  (
    umask 077
    cat > .env <<EOF
BEEPER_BASE_URL=${BEEPER_URL}
CLAUDE_MESSENGER_POLICY=${INSTALL_DIR}/policy.json
CLAUDE_MESSENGER_AUDIT_DIR=${INSTALL_DIR}/audit
CLAUDE_MESSENGER_STATE_DIR=${INSTALL_DIR}/state
CLAUDE_MESSENGER_MCP_TOKEN=$(openssl rand -hex 32)
EOF
  )
fi
ok ".env in $INSTALL_DIR"

say "Beeper access"
if [ "$RECONNECT" -eq 1 ] || ! grep -q '^BEEPER_ACCESS_TOKEN=.' .env; then
  if [ -e "$UNIT_DIR/beeper-desktop.service" ]; then
    # Beeper runs headless here: its window is only on the sign-in surface.
    SURFACE_OPEN=1
    bash "$SURFACE" up || die "the Beeper screen could not be opened; see above, then run ${SELF} again."
  fi
  cli connect --timeout "$APPROVAL_MINUTES" || die "Beeper access was not granted; see above, then run ${SELF} again."
  if [ "$SURFACE_OPEN" -eq 1 ]; then
    close_surface || die "the Beeper sign-in surface is still exposed; close it before using this host: $SURFACE down"
    ok "sign-in surface closed"
  fi
else
  ok "Beeper token already in .env (to replace it: ${SELF} --reconnect)"
fi

[ -f policy.json ] || cli policy-init
cli doctor ||
  die "doctor failed; see above. If Beeper was signed out, which deletes its approvals, run: ${SELF} --reconnect"
ok "doctor green (policy: read-only until you edit policy.json)"

say "MCP service"
# The unit may write only these, and systemd refuses to start it if either is missing.
mkdir -p audit state
mkdir -p "$UNIT_DIR"
# __NODE__ must be the RESOLVED interpreter: /usr/bin/node only exists on
# apt installs; nvm/asdf setups would 203/EXEC with a hardcoded path.
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__PORT__|$MCP_PORT|g; s|__NODE__|$(command -v node)|g" \
  "$INSTALL_DIR/deploy/systemd/claude-messenger-mcp.service" > "$UNIT_DIR/claude-messenger-mcp.service"
systemctl --user daemon-reload
systemctl --user enable claude-messenger-mcp.service
# restart, not enable --now: re-runs are upgrades and must swap the process.
systemctl --user restart claude-messenger-mcp.service
# Node can take a while to start on a small, busy host.
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MCP_PORT}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
[ "$healthy" -eq 1 ] || die "MCP service failed to start — check: journalctl --user -u claude-messenger-mcp"
ok "claude-messenger-mcp.service answering on http://127.0.0.1:${MCP_PORT}/mcp"

# HTTPS on the tailnet only; the MCP port itself stays on loopback.
published=0
if out="$(timeout -k 2 "$SERVE_TIMEOUT" sudo tailscale serve --bg "http://127.0.0.1:${MCP_PORT}" 2>&1)"; then
  published=1
  ok "published to your tailnet over HTTPS"
else
  # Not fatal: sessions on this host use the loopback URL. tailscale's own
  # words say why, with the link that turns Serve on if the tailnet hasn't.
  warn "not published to your tailnet; sessions on this host can still use it. tailscale said:"
  printf '%s\n' "${out:-(nothing)}" | sed 's/^/    /'
  warn "Once that is fixed, run ${SELF} again."
fi

if command -v claude >/dev/null; then
  token="$(sed -n 's/^CLAUDE_MESSENGER_MCP_TOKEN=//p' .env | tail -n 1)"
  # Output discarded: `claude mcp add` echoes the headers, token included.
  claude mcp remove claude-messenger --scope user >/dev/null 2>&1 || true
  if claude mcp add --scope user --transport http claude-messenger "http://127.0.0.1:${MCP_PORT}/mcp" \
    --header "Authorization: Bearer ${token}" >/dev/null 2>&1; then
    ok "Claude Code sessions on this host have it as the claude-messenger MCP server"
  else
    warn "could not add the MCP server to Claude Code on this host; see docs/DEPLOY.md to add it by hand"
  fi
fi

if [ "$published" -eq 1 ]; then
  # `|| true` inside the substitution: a tailscaled hiccup at the very end
  # must not (via pipefail) kill an otherwise-successful install.
  MAGICDNS="$({ tailscale status --json 2>/dev/null || true; } | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const n=JSON.parse(d).Self.DNSName.replace(/\.$/,"");console.log(n||"<this-host>")}catch{console.log("<this-host>")}})')"
  URL="https://${MAGICDNS}/mcp"
  WHERE="any device on your tailnet"
else
  URL="http://127.0.0.1:${MCP_PORT}/mcp"
  WHERE="this host only, until it is on your tailnet (see above)"
fi
cat <<EOF

════════════════════════════════════════════════════════════════════
 Claude Messenger is hosted. Connect a Claude client from
 ${WHERE}:

   URL:    ${URL}
   Token:  in ${INSTALL_DIR}/.env — print it with:
             grep CLAUDE_MESSENGER_MCP_TOKEN ${INSTALL_DIR}/.env

   Claude Code:
     claude mcp add claude-messenger --transport http ${URL} \\
       --header "Authorization: Bearer \$(grep CLAUDE_MESSENGER_MCP_TOKEN ${INSTALL_DIR}/.env | cut -d= -f2)"

 Policy is READ-ONLY until you edit ${INSTALL_DIR}/policy.json.
 Audit trail: ${INSTALL_DIR}/audit/
════════════════════════════════════════════════════════════════════
EOF
