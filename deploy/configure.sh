#!/usr/bin/env bash
# Claude Messenger — connect this install to Beeper and start its MCP service.
#
# The last step of deploy/bootstrap.sh, and safe to re-run on its own:
#
#   deploy/configure.sh              # finish or repair an install; restarts the service
#   deploy/configure.sh --reconnect  # get a new Beeper token, e.g. after Beeper was signed out
#
# It never prompts, so a Claude session can run it without a terminal, given
# a sudo that needs no password there. The person's only steps happen in
# Beeper's own window: signing in, and approving Claude Messenger's access.
# The token then goes from Beeper straight into .env (`claude-messenger
# connect`), so nobody types it and no transcript holds it. When Beeper runs
# headless on this host, its window is reachable only through the sign-in
# surface, which this opens for the approval. Every run closes it before
# going on, whether that run opened it or not, and on any exit but a kill -9;
# after one of those, run this again.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_PORT="${CLAUDE_MESSENGER_MCP_PORT:-8484}"
BEEPER_URL="${BEEPER_BASE_URL:-http://127.0.0.1:23373}"
# A tailnet that has not allowed Tailscale Serve makes `tailscale serve` wait
# for someone to allow it; past this many seconds, stop waiting.
SERVE_TIMEOUT="${CLAUDE_MESSENGER_SERVE_TIMEOUT:-20}"
# How long the person has to sign in to Beeper and approve. Whatever runs
# this in the background must give it longer than that.
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

# .env, the service and Beeper's own data all belong to one regular user.
[ "$(id -u)" -ne 0 ] || die "Run as the user who owns this install, not root."

# Beeper Desktop installed by bootstrap runs headless, so its window is only
# on the sign-in surface.
MANAGED=0
[ -e "$UNIT_DIR/beeper-desktop.service" ] && MANAGED=1

# Taken as open until `down` proves it closed: a manual `up` or a killed run
# can have left it open, and no exit may leave it so.
SURFACE_OPEN=$MANAGED
CONNECT_PID=""
# `down` verifies the end state, so this fails if anything is left exposed.
# The flag drops only once that is proven.
close_surface() {
  bash "$SURFACE" down || return 1
  SURFACE_OPEN=0
}
on_exit() {
  # Another signal must not cut the cleanup short; what it runs inherits this.
  trap '' INT TERM HUP
  if [ -n "$CONNECT_PID" ]; then kill "$CONNECT_PID" 2>/dev/null || true; fi
  if [ "$SURFACE_OPEN" -eq 1 ]; then
    close_surface || warn "the Beeper sign-in surface may still be exposed; close it: $SURFACE down"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

cd "$INSTALL_DIR"
[ -f dist/cli/main.js ] || die "Claude Messenger is not built in $INSTALL_DIR; run deploy/bootstrap.sh first."
cli() { node dist/cli/main.js "$@"; }

# The MCP service is a system unit (see its header in deploy/systemd/), so
# installing it takes root. Find out now, before anyone is asked to approve
# anything. -n first: on a cloud image, -v asks for a password even where
# every command runs without one.
sudo -n true 2>/dev/null || sudo -v ||
  die "this needs sudo, which it could not get; see above. Run ${SELF} where sudo can ask for your password, or let this user use sudo without one."

say "Configuration"
# Nobody else on this host may read this home: it holds .env (the Beeper
# token) and, on a managed host, Beeper's own data. Either bypasses the policy
# layer. See docs/SHARED-HOST.md, rule 1.
chmod go-rwx "$HOME"
# Generated outside the heredoc, where a failure would go unnoticed.
new_mcp_token() { openssl rand -hex 32 || die "openssl could not generate the MCP bearer token"; }
# Whether .env gives $1 a value, read as Node loads it: grep would take
# KEY="" for one, or a CRLF line's KEY=\r.
env_has() {
  node -e 'process.exit(require("node:util").parseEnv(require("node:fs").readFileSync(".env", "utf8"))[process.argv[1]] ? 0 : 1)' "$1"
}
if [ ! -f .env ]; then
  mcp_token="$(new_mcp_token)"
  # umask first: the file must never exist world-readable, even briefly. The
  # Beeper token is added by `connect`, below.
  (
    umask 077
    cat > .env <<EOF
BEEPER_BASE_URL=${BEEPER_URL}
CLAUDE_MESSENGER_POLICY=${INSTALL_DIR}/policy.json
CLAUDE_MESSENGER_AUDIT_DIR=${INSTALL_DIR}/audit
CLAUDE_MESSENGER_STATE_DIR=${INSTALL_DIR}/state
CLAUDE_MESSENGER_MCP_TOKEN=${mcp_token}
EOF
  )
else
  # One made by hand may be readable by others.
  chmod 600 .env
  if ! env_has CLAUDE_MESSENGER_MCP_TOKEN; then
    # A hand-made .env (from .env.example, say) has none, and the service
    # won't start without it. printf is a builtin: no command line shows it.
    mcp_token="$(new_mcp_token)"
    sed -i --follow-symlinks '/^CLAUDE_MESSENGER_MCP_TOKEN=/d' .env
    # Appended to a last line that has no newline, it would corrupt that line.
    [ -z "$(tail -c 1 .env)" ] || printf '\n' >> .env
    printf 'CLAUDE_MESSENGER_MCP_TOKEN=%s\n' "$mcp_token" >> .env
  fi
fi
unset mcp_token
# The MCP service sees nothing of this home but the install, and can change
# only its audit/ and state/ (see its unit). A policy, audit trail or rate
# window that .env keeps anywhere else would be out of its reach: every call
# would fail, or a policy it can't see would give way to the default one.
# Read as Node loads .env, from the service's working directory.
misplaced="$(node -e '
  const { resolve } = require("node:path");
  const env = require("node:util").parseEnv(require("node:fs").readFileSync(".env", "utf8"));
  const dir = process.argv[1];
  for (const [key, place] of [["CLAUDE_MESSENGER_POLICY", "policy.json"], ["CLAUDE_MESSENGER_AUDIT_DIR", "audit"], ["CLAUDE_MESSENGER_STATE_DIR", "state"]]) {
    const value = env[key] ?? `./${place}`;
    if (resolve(dir, value) !== resolve(dir, place)) console.log(`    ${key}=${value}, not ${resolve(dir, place)}`);
  }' "$INSTALL_DIR")"
[ -z "$misplaced" ] ||
  die "the MCP service can reach only this install's policy.json, audit/ and state/, and .env puts some elsewhere:
${misplaced}
  Point those lines there, or delete them, then run ${SELF} again."
ok ".env in $INSTALL_DIR"

say "Beeper access"
if [ "$RECONNECT" -eq 1 ] || ! env_has BEEPER_ACCESS_TOKEN; then
  if [ "$MANAGED" -eq 1 ]; then
    bash "$SURFACE" up || die "the Beeper screen could not be opened; see above, then run ${SELF} again."
  fi
  # In the background, so a signal to this script ends the wait at once
  # rather than whenever connect returns. node itself, not the cli function,
  # so that $! is the process to stop.
  node dist/cli/main.js connect --timeout "$APPROVAL_MINUTES" &
  CONNECT_PID=$!
  granted=0
  wait "$CONNECT_PID" && granted=1
  CONNECT_PID=""
  [ "$granted" -eq 1 ] || die "Beeper access was not granted; see above, then run ${SELF} again."
else
  ok "Beeper token already in .env (to replace it: ${SELF} --reconnect)"
fi
if [ "$MANAGED" -eq 1 ]; then
  # On every run, not only one that opened it: a killed run or a manual `up`
  # can have left it open, and nothing below runs beside an open surface.
  close_surface || die "the Beeper sign-in surface is still exposed; close it before using this host: $SURFACE down"
  ok "sign-in surface closed"
fi

[ -f policy.json ] || cli policy-init
cli doctor ||
  die "doctor failed; see above. If Beeper was signed out, which deletes its approvals, run: ${SELF} --reconnect"
ok "doctor green (policy: read-only until you edit policy.json)"

say "MCP service"
MCP_UNIT=claude-messenger-mcp.service
# Earlier installs ran it as a user unit, whose sandbox Ubuntu drops without a
# word (see the unit's header). Left running, that one would keep the port.
if [ -e "$UNIT_DIR/$MCP_UNIT" ]; then
  systemctl --user disable --now "$MCP_UNIT" ||
    die "the MCP service an earlier install ran as a user unit did not stop; stop it (systemctl --user disable --now $MCP_UNIT), then run ${SELF} again."
  rm -f "$UNIT_DIR/$MCP_UNIT"
  systemctl --user daemon-reload
fi
# The unit may write only these, and systemd refuses to start it if either is missing.
mkdir -p audit state
# Run as this user. __NODE__ must be the interpreter itself: /usr/bin/node
# only exists on apt installs, an nvm or asdf node lives in this home, which
# the sandbox hides but for what the unit lets through, and an asdf shim is a
# script that needs the rest of asdf.
NODE="$(node -p process.execPath)"
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__PORT__|$MCP_PORT|g; s|__NODE__|$NODE|g; s|__USER__|$(id -un)|g" \
  "$INSTALL_DIR/deploy/systemd/claude-messenger-mcp.service" | sudo tee "/etc/systemd/system/$MCP_UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$MCP_UNIT"
# restart, not enable --now: re-runs are upgrades and must swap the process.
sudo systemctl restart "$MCP_UNIT"
# Node can take a while to start on a small, busy host.
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MCP_PORT}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  # The restart reports success even when the start fails later (sandbox,
  # user, node); the unit is then no longer active, and waiting won't help.
  systemctl is-active --quiet "$MCP_UNIT" || break
  sleep 1
done
[ "$healthy" -eq 1 ] || die "MCP service failed to start — check: sudo journalctl -u ${MCP_UNIT}"
ok "${MCP_UNIT} answering on http://127.0.0.1:${MCP_PORT}/mcp"

# HTTPS on the tailnet only; the MCP port itself stays on loopback. Under
# `timeout`, sudo runs outside the terminal's foreground and can't ask for a
# password; the sudo steps just above have already let it ask.
published=0
if out="$(timeout -k 2 "$SERVE_TIMEOUT" sudo -n tailscale serve --bg "http://127.0.0.1:${MCP_PORT}" 2>&1)"; then
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
  # Over stdio: each session starts its own server, which reads .env here.
  # A bearer token would have to go on claude's command line, which every
  # local user can read, and into Claude's config.
  claude mcp remove claude-messenger --scope user >/dev/null 2>&1 || true
  if claude mcp add --scope user claude-messenger -- \
    sh -c 'cd "$1" && exec "$2" dist/cli/main.js serve' claude-messenger "$INSTALL_DIR" "$(command -v node)" \
    >/dev/null 2>&1; then
    ok "Claude Code sessions on this host have it as the claude-messenger MCP server"
  else
    warn "could not add the MCP server to Claude Code on this host; see docs/SETUP.md to add it by hand"
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
   Token:  CLAUDE_MESSENGER_MCP_TOKEN in ${INSTALL_DIR}/.env

   Claude Code elsewhere (sessions on this host already have it):
     claude mcp add claude-messenger --transport http ${URL} \\
       --header "Authorization: Bearer <that token>"

 Policy is READ-ONLY until you edit ${INSTALL_DIR}/policy.json.
 Audit trail: ${INSTALL_DIR}/audit/
════════════════════════════════════════════════════════════════════
EOF
