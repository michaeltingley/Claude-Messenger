#!/usr/bin/env bash
# Claude Messenger — the responder, as a service.
#
# `claude-messenger respond` answers the owner's @Claude, and what they write
# in Claude's chat with them, from the assistant's own Beeper account ("The
# assistant's own account" in docs/ARCHITECTURE.md). This runs it as the
# system unit claude-messenger-responder.service, sandboxed like the MCP
# service (see the unit), and signs in the Claude Code that writes its answers:
#
#   deploy/responder.sh                  # install or update the service, and start it
#   deploy/responder.sh sign-in start    # sign Claude Code in for it: prints the link to approve
#   deploy/responder.sh sign-in finish   # finish with the code that link shows, read from stdin
#
# Claude Code answers on the owner's Claude subscription, with a token of the
# service's own, made by `claude setup-token`: one that can only write
# answers (no connectors such as the owner's Gmail, no sessions), for a year.
# It goes from Claude Code's screen into a file only the owner can read,
# never displayed, so it passes through no terminal, chat or screen. The
# person approves on claude.ai and passes back the code it shows, which
# redeems nothing without the half of the sign-in that waits here. So both
# halves run from one session, which must not end in between.
#
# It never prompts, so a Claude session can run it, given a sudo that needs
# no password there (only the install uses sudo).
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=claude-messenger-responder.service
UNIT_FILE="$INSTALL_DIR/deploy/systemd/claude-messenger-responder.service"
# The assistant's own configuration, which deploy/assistant-beeper.sh makes:
# its .env signs in to its Beeper account.
ASSISTANT_DIR="${ASSISTANT_CONFIG_DIR:-$HOME/.config/claude-messenger/assistant}"
# Claude Code's token for the service, which the unit loads (EnvironmentFile=).
TOKEN_FILE="$ASSISTANT_DIR/claude-code.env"
# The service's own Claude Code configuration (CLAUDE_CONFIG_DIR in the unit).
CLAUDE_CONFIG="$ASSISTANT_DIR/state/claude-code"
# A sign-in under way: Claude Code waiting for the code, and what its screen shows.
SIGN_IN="$ASSISTANT_DIR/claude-sign-in"
# How long a sign-in waits for its code before giving up.
SIGN_IN_MINUTES=30
# Long enough for a slow start on a small, busy host.
START_SECONDS=60
SELF="$(basename "$0")"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

usage() { echo "usage: ${SELF} [sign-in start | sign-in finish]" >&2; exit 2; }
[ $# -le 2 ] || usage
case "${1:-} ${2:-}" in
  " ") ACTION=install ;;
  "sign-in start") ACTION=sign-in-start ;;
  "sign-in finish") ACTION=sign-in-finish ;;
  *) usage ;;
esac

# The service runs as the owner, and everything here is theirs.
[ "$(id -u)" -ne 0 ] || die "Run as the user who owns this install, not root."

TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT

# Whether the env file $1 gives $2 a value, read as Node loads it; prints the value.
env_value() {
  node -e '
    const env = require("node:util").parseEnv(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = env[process.argv[2]];
    if (!value) process.exit(1);
    console.log(value);' "$1" "$2"
}

# What Claude Code's screen shows in the file $2, which holds everything it
# wrote to its terminal. Its screens place words by moving the cursor and
# redraw only what changed, so the bytes are not the text: they are replayed
# here onto a grid of cells, as a terminal draws them. $1 says what to print:
#   link    the sign-in link it shows (exits 1 while there is none)
#   text    its last lines, for a sign-in that failed before showing a link
#   result  "token", having saved the token it shows to the file $3, never
#           printing it; or "error <its words>"; or nothing (exits 1) yet
screen() {
  node -e '
    const fs = require("node:fs");
    const [what, file, tokenFile] = process.argv.slice(1);
    let out = "";
    try { out = fs.readFileSync(file, "utf8"); } catch {}
    // What Claude Code showed, without the lines script(1) writes around it.
    out = out.replace(/^Script started on [^\n]*\n/, "").replace(/\nScript done on [^\n]*\n?$/, "");
    const grid = [];
    const links = [];
    let row = 0, col = 0, saved = [0, 0];
    const line = () => (grid[row] ??= []);
    replay: for (let i = 0; i < out.length; ) {
      const ch = out[i];
      if (ch === "\x1b") {
        const rest = out.slice(i, i + 4096);
        const csi = /^\x1b\[([0-?]*)[ -\/]*([@-~])/.exec(rest);
        const osc = /^\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(rest);
        if (csi) {
          const [n, m] = csi[1].split(";").map(Number);
          switch (csi[2]) {
            case "A": row = Math.max(0, row - (n || 1)); break;
            case "B": row += n || 1; break;
            case "C": col += n || 1; break;
            case "D": col = Math.max(0, col - (n || 1)); break;
            case "G": col = (n || 1) - 1; break;
            case "H": case "f": row = (n || 1) - 1; col = (m || 1) - 1; break;
            case "K":
              if (!n) line().length = Math.min(line().length, col);
              else if (n === 1) for (let x = 0; x <= col; x++) line()[x] = " ";
              else grid[row] = [];
              break;
            case "J":
              if (!n) { grid.length = Math.min(grid.length, row + 1); line().length = Math.min(line().length, col); }
              else if (n === 1) for (let y = 0; y < row; y++) grid[y] = [];
              else grid.length = 0;
              break;
          }
          i += csi[0].length;
        } else if (osc) {
          // A hyperlink: ESC ] 8 ; params ; URI. The URI is the whole link, however its text wraps.
          const link = /^8;[^;]*;(.+)$/.exec(osc[1]);
          if (link) links.push(link[1]);
          i += osc[0].length;
        } else if (rest.length < 2 || (rest[1] === "[" || rest[1] === "]")) {
          break replay; // not all written yet
        } else if (rest[1] === "7") { saved = [row, col]; i += 2; }
        else if (rest[1] === "8") { [row, col] = saved; i += 2; }
        else if ("()*+-./#%".includes(rest[1])) i += 3;
        else i += 2;
        continue;
      }
      if (ch === "\r") col = 0;
      else if (ch === "\n") row++;
      else if (ch === "\b") col = Math.max(0, col - 1);
      else if (ch === "\t") col = (col + 8) & ~7;
      else if (ch >= " " && ch !== "\x7f") {
        const glyph = String.fromCodePoint(out.codePointAt(i));
        line()[col++] = glyph;
        i += glyph.length;
        continue;
      }
      i++;
    }
    const lines = grid.map((cells) => Array.from(cells ?? [], (c) => c ?? " ").join("").trimEnd());
    // Never print a token, whatever line it might turn up in.
    const shown = (text) => text.trim().replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");
    if (what === "link") {
      const link = links.filter((l) => l.startsWith("https://")).at(-1) ?? lines.join(" ").match(/https:\/\/\S+/g)?.at(-1);
      if (!link) process.exit(1);
      console.log(link);
    } else if (what === "text") {
      console.log(lines.filter((l) => l.trim()).slice(-10).map(shown).join("\n"));
    } else {
      // Shown on a line of its own, as Claude Code shows it.
      const token = lines.map((l) => /^\s*(sk-ant-oat\d+-[A-Za-z0-9_-]{20,})$/.exec(l)?.[1]).filter(Boolean).at(-1);
      if (token) {
        // Owner-only from the start, and whole or not at all.
        const partial = `${tokenFile}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(partial, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
          fs.renameSync(partial, tokenFile);
        } finally {
          fs.rmSync(partial, { force: true });
        }
        console.log("token");
      } else {
        const error = lines.find((l) => /\b(error|failed|timed out|expired|invalid)\b/i.test(l));
        if (!error) process.exit(1);
        console.log(`error ${shown(error)}`);
      }
    }' "$@"
}

# Whether the process $1 is a sign-in's, still running: not one that has
# since taken its pid, nor one that has ended (a zombie has no command line).
# It leads the sign-in's process group, and ends last.
is_sign_in() {
  { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null | grep -q 'claude setup-token'
}

# The sign-in under way, if any: the process that leads it.
sign_in_pid() {
  local pid
  pid="$(cat "$SIGN_IN/pid" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && is_sign_in "$pid" || return 1
  echo "$pid"
}

# Ends the sign-in under way, if any, and deletes what it left: the screen, which may show a token.
stop_sign_in() {
  local pid
  if pid="$(sign_in_pid)"; then
    kill -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      is_sign_in "$pid" || break
      sleep 0.1
    done
    kill -9 -- "-$pid" 2>/dev/null || true
  fi
  rm -rf "$SIGN_IN"
}

sign_in_start() {
  [ -d "$ASSISTANT_DIR" ] ||
    die "${ASSISTANT_DIR} does not exist. Make the assistant's configuration first: deploy/assistant-beeper.sh"
  [ -f "$INSTALL_DIR/dist/index.js" ] || die "Claude Messenger is not built in ${INSTALL_DIR}; run deploy/bootstrap.sh first."
  command -v claude >/dev/null || die "Claude Code is not installed here (no claude on PATH). Install it, then run ${SELF} sign-in start again."
  command -v script >/dev/null || die "this needs script (from util-linux), which gives Claude Code the terminal it signs in on."
  # One waiting from an earlier start: its link is no longer the one to use.
  stop_sign_in

  say "Claude Code's sign-in for the responder"
  (umask 077 && mkdir "$SIGN_IN" && mkfifo "$SIGN_IN/input")
  # Claude Code signs in only on a terminal, so script gives it one, as wide
  # as a token is long, and keeps what it shows in $SIGN_IN/screen. It reads
  # the code from the input FIFO, which it holds open itself, so it waits for
  # one however long the person takes, up to the limit `timeout` sets. Its own
  # session (setsid) keeps it waiting after this returns, and its environment
  # is only what it needs: none of the Claude session's that runs this, and no
  # display, so it can't open a browser on the host. Its configuration is a
  # throwaway one: the token is all that is kept.
  local -a env=(HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM=xterm-256color CLAUDE_CONFIG_DIR="$SIGN_IN/claude-code")
  local name
  for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR; do
    [ -z "${!name:-}" ] || env+=("${name}=${!name}")
  done
  (
    umask 077
    cd "$SIGN_IN"
    exec env -i "${env[@]}" setsid timeout "$((SIGN_IN_MINUTES * 60))" \
      script -qfec "stty cols 1000 rows 100; exec claude setup-token" "$SIGN_IN/screen" <>"$SIGN_IN/input" >/dev/null 2>&1
  ) &
  local pid=$!
  echo "$pid" > "$SIGN_IN/pid"

  local link="" deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    link="$(screen link "$SIGN_IN/screen")" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if [ -z "$link" ]; then
    local said
    said="$(screen text "$SIGN_IN/screen" | sed 's/^/    /')"
    stop_sign_in
    die "Claude Code showed no sign-in link. It said:
${said:-    (nothing)}"
  fi
  # Only a token that can do no more than write answers. A link asking for
  # more would make one that could, through the owner's account, read their
  # connectors (their Gmail, say) or their sessions.
  local refused
  if ! refused="$(node -e '
    let url;
    try { url = new URL(process.argv[1]); } catch { console.log("it is not a link"); process.exit(1); }
    if (url.protocol !== "https:") { console.log("it is not https"); process.exit(1); }
    const scope = url.searchParams.get("scope");
    if (scope !== "user:inference") { console.log(`it asks for ${scope ?? "nothing"}, not user:inference alone`); process.exit(1); }' "$link")"; then
    stop_sign_in
    die "Claude Code's sign-in link was refused: ${refused}. Nothing was signed in."
  fi
  ok "Claude Code is waiting for its sign-in, for up to ${SIGN_IN_MINUTES} minutes"
  cat <<EOF

 Open this link where you are signed in to claude.ai, and approve. It asks
 only to write with your subscription (user:inference):

   ${link}

 The page then shows a code. Finish with it, from this same session:

   printf '%s\\n' '<the code>' | ${SELF} sign-in finish
EOF
}

sign_in_finish() {
  sign_in_pid >/dev/null || {
    rm -rf "$SIGN_IN"
    die "No sign-in is waiting: it was never started, it ended, or the session that started it did. Start one: ${SELF} sign-in start"
  }
  local code=""
  IFS= read -r code || true
  code="${code//[[:space:]]/}"
  # Anything else would be keys pressed on Claude Code's screen. The sign-in
  # keeps waiting, for the right code.
  case "$code" in
    "") die "No code on stdin. Finish with: printf '%s\\n' '<the code>' | ${SELF} sign-in finish" ;;
    *[!A-Za-z0-9#._~+/=-]*) die "That is not a code Claude Code's sign-in page shows; the sign-in still waits for one." ;;
  esac

  say "Finishing Claude Code's sign-in"
  # From here, however this ends, nothing of the sign-in is left behind.
  trap 'stop_sign_in; cleanup' EXIT
  # Opened read-write, as Claude Code's side holds it, so this can't block.
  exec 3<>"$SIGN_IN/input"
  printf '%s\r' "$code" >&3
  exec 3>&-
  local result="" deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    result="$(screen result "$SIGN_IN/screen" "$TOKEN_FILE")" && break
    if ! sign_in_pid >/dev/null; then
      # Ended: what it showed last, which may have come as it ended.
      result="$(screen result "$SIGN_IN/screen" "$TOKEN_FILE")" || true
      break
    fi
    sleep 0.2
  done
  stop_sign_in
  case "$result" in
    token) ok "Claude Code is signed in for the responder. Its token is in ${TOKEN_FILE}; it was never displayed." ;;
    "error "*) die "Claude Code's sign-in failed: ${result#error }. Nothing was saved; start again: ${SELF} sign-in start" ;;
    *) die "Claude Code showed neither a token nor an error. Nothing was saved; start again: ${SELF} sign-in start" ;;
  esac

  # Checked as the service will use it: its model, its configuration, this token.
  say "Checking Claude Code answers with it"
  (umask 077 && mkdir -p "$CLAUDE_CONFIG")
  local answer
  if ! answer="$(cd "$INSTALL_DIR" &&
    CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG" CLAUDE_CODE_OAUTH_TOKEN="$(env_value "$TOKEN_FILE" CLAUDE_CODE_OAUTH_TOKEN)" \
      node --input-type=module -e '
        import { ClaudeCodeModel } from "./dist/index.js";
        try {
          const model = new ClaudeCodeModel({ model: "haiku", timeoutMs: 120_000 });
          await model.write({ instructions: "Reply with the one word: ready.", input: "Are you there?" });
        } catch (err) {
          console.log(err.message);
          process.exit(1);
        }' 2>&1)"; then
    die "Claude Code could not answer with the new token: ${answer}"
  fi
  ok "Claude Code answers with it"
  echo "Next: ${SELF}, which starts the responder with it, or restarts it onto it."
}

install_service() {
  cd "$INSTALL_DIR"
  [ -f dist/cli/main.js ] || die "Claude Messenger is not built in ${INSTALL_DIR}; run deploy/bootstrap.sh first."

  say "What it answers with"
  # Before anything changes: everything the service needs, each with how to get it.
  [ -f .env ] && env_value .env BEEPER_ACCESS_TOKEN >/dev/null ||
    die "${INSTALL_DIR}/.env has no Beeper token, so the responder can't read your messages. Connect your Beeper first: deploy/configure.sh"
  [ -d "$ASSISTANT_DIR" ] && [ -f "$ASSISTANT_DIR/.env" ] && env_value "$ASSISTANT_DIR/.env" BEEPER_ACCESS_TOKEN >/dev/null ||
    die "the assistant has no Beeper account here yet (no token in ${ASSISTANT_DIR}/.env). See docs/SETUP.md."
  ASSISTANT_DIR="$(cd "$ASSISTANT_DIR" && pwd)"
  TOKEN_FILE="$ASSISTANT_DIR/claude-code.env"
  CLAUDE_CONFIG="$ASSISTANT_DIR/state/claude-code"
  # The service can reach only each one's own policy.json, audit/ and state/
  # (see its unit). A .env that kept one elsewhere would leave it unable to
  # audit, or reading the owner's chats under the default policy instead of
  # theirs. Read as Node loads each .env, relative to its directory.
  local dir misplaced
  for dir in "$INSTALL_DIR" "$ASSISTANT_DIR"; do
    misplaced="$(node -e '
      const { join, resolve } = require("node:path");
      const dir = process.argv[1];
      const env = require("node:util").parseEnv(require("node:fs").readFileSync(join(dir, ".env"), "utf8"));
      for (const [key, place] of [["CLAUDE_MESSENGER_POLICY", "policy.json"], ["CLAUDE_MESSENGER_AUDIT_DIR", "audit"], ["CLAUDE_MESSENGER_STATE_DIR", "state"]]) {
        const value = env[key] ?? `./${place}`;
        if (resolve(dir, value) !== resolve(dir, place)) console.log(`    ${key}=${value}, not ${resolve(dir, place)}`);
      }' "$dir")"
    [ -z "$misplaced" ] ||
      die "the responder can reach only ${dir}'s own policy.json, audit/ and state/, and ${dir}/.env puts some elsewhere:
${misplaced}
  Point those lines there, or delete them, then run ${SELF} again."
  done
  local claude
  claude="$(command -v claude)" ||
    die "Claude Code is not installed here (no claude on PATH). Install it, sign it in for the responder (${SELF} sign-in start), then run ${SELF} again."
  env_value "$TOKEN_FILE" CLAUDE_CODE_OAUTH_TOKEN >/dev/null 2>&1 ||
    die "Claude Code is not signed in for the responder (no token in ${TOKEN_FILE}). Sign it in: ${SELF} sign-in start"
  ok "your Beeper, the assistant's account, and Claude Code (${claude}), signed in for it"

  # Times in answers are the owner's: as asked, else as the service already
  # gives them, so an update keeps them, else this host's.
  local zone="${RESPONDER_TIME_ZONE:-}"
  [ -n "$zone" ] ||
    zone="$(systemctl cat "$UNIT" 2>/dev/null | sed -n 's/^ExecStart=.* --time-zone \([^ ]*\).*$/\1/p' | tail -n 1 || true)"
  [ -n "$zone" ] || zone="$(node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')"
  local zone_ok=1
  case "$zone" in "" | *[!A-Za-z0-9_+/-]*) zone_ok=0 ;; esac
  [ "$zone_ok" -eq 1 ] && node -e 'new Intl.DateTimeFormat("en-US", { timeZone: process.argv[1] })' "$zone" 2>/dev/null ||
    die "RESPONDER_TIME_ZONE must be an IANA time zone, such as America/Los_Angeles, not '${zone}'."

  # __NODE__ must be the interpreter itself, for the reason configure.sh gives.
  local node
  node="$(node -p process.execPath)"
  # Each goes into the unit as written: a space would split a list of paths,
  # and a colon or a % means something there.
  local path
  for path in "$INSTALL_DIR" "$ASSISTANT_DIR" "$node" "$claude"; do
    case "$path" in
      /*[!A-Za-z0-9._/@+-]* | [!/]*) die "${path} can't go into a unit file as written; the responder needs a path of letters, digits and . _ / @ + - only." ;;
    esac
  done

  # Only now: the checks above need no root.
  sudo -n true 2>/dev/null || sudo -v ||
    die "this needs sudo, which it could not get; see above. Run ${SELF} where sudo can ask for your password, or let this user use sudo without one."

  say "Responder service"
  # The unit may write only these, and systemd refuses to start it if any is missing.
  mkdir -p audit state "$ASSISTANT_DIR/audit" "$ASSISTANT_DIR/state"
  (umask 077 && mkdir -p "$CLAUDE_CONFIG")
  local systemd_major
  systemd_major="$(systemctl --version | sed -n 's/^systemd \([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [ -n "$systemd_major" ] && [ "$systemd_major" -lt 257 ]; then
    warn "systemd ${systemd_major} is older than 257, so the responder cannot get its own process namespace (PrivatePIDs). The rest of its sandbox applies, but a responder that was compromised could read your other processes' files and environment through /proc, your own Claude Code sign-in among them. Ubuntu 24.10+ and 26.04 ship 257 or newer."
  fi
  local unit_text
  unit_text="$(sed -e "s|__USER__|$(id -un)|g" -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" -e "s|__ASSISTANT_DIR__|${ASSISTANT_DIR}|g" \
    -e "s|__NODE__|${node}|g" -e "s|__CLAUDE_DIR__|${claude%/*}|g" -e "s|__CLAUDE__|${claude}|g" -e "s|__TIME_ZONE__|${zone}|g" \
    "$UNIT_FILE")"
  # `systemctl cat` prints the installed file after a line naming it.
  if [ "$(systemctl cat "$UNIT" 2>/dev/null | tail -n +2)" != "$unit_text" ]; then
    printf '%s\n' "$unit_text" | sudo tee "/etc/systemd/system/$UNIT" >/dev/null
    sudo systemctl daemon-reload
  fi
  sudo systemctl enable "$UNIT"
  # Stopped, then started: an update must swap the running process. As it
  # starts answering, the responder saves where it has got to, which is how
  # this knows it did. Stopped first, since a run being stopped may save too.
  sudo systemctl stop "$UNIT"
  TMP="$(mktemp -d)"
  touch "$TMP/started"
  sudo systemctl start "$UNIT"
  local answering=0 deadline=$((SECONDS + START_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -n "$(find "$ASSISTANT_DIR/state/responder.json" -newer "$TMP/started" 2>/dev/null)" ]; then
      answering=1
      break
    fi
    # A start that fails after the fork still reports success; the unit is
    # then no longer active, and waiting won't help.
    systemctl is-active --quiet "$UNIT" || break
    sleep 0.2
  done
  [ "$answering" -eq 1 ] || die "the responder did not start answering. Check: sudo journalctl -u ${UNIT}"
  ok "${UNIT}: answering @Claude from the assistant's account, with times in ${zone}"
  [ -n "${RESPONDER_TIME_ZONE:-}" ] || echo "  To give times in another zone: RESPONDER_TIME_ZONE=<zone> ${SELF}"
}

case "$ACTION" in
  install) install_service ;;
  sign-in-start) sign_in_start ;;
  sign-in-finish) sign_in_finish ;;
esac
