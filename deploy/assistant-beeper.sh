#!/usr/bin/env bash
# Claude Messenger — the runtime for the assistant's own Beeper account.
#
# The assistant answers from a Beeper account of its own, so nothing it says
# is ever sent as the owner ("The assistant's own account" in
# docs/ARCHITECTURE.md). That account runs on Beeper Server, Beeper's headless
# runtime, as the system unit assistant-beeper.service: on 127.0.0.1:23374,
# under a user of its own (see the unit's header). This installs it, or
# updates it to Beeper's latest stable build, and starts it:
#
#   deploy/assistant-beeper.sh           # install or update; with nothing new, a re-run changes nothing
#   deploy/assistant-beeper.sh --reset   # delete its account data and start it signed out
#
# It also makes the assistant's own configuration directory, whose .env points
# at this runtime. It never prompts, so a Claude session can run it, given a
# sudo that needs no password there.
#
# Not through Beeper's `beeper` CLI: its latest release (0.6.2) installs a
# nightly Server whatever channel is asked for (beeper/cli#21, fixed only on
# its main branch), and its setup adopts the Beeper Desktop it finds on
# 127.0.0.1:23373, which here is the owner's. This takes the build straight
# from Beeper's stable update feed, checked against the feed's SHA-512.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ASSISTANT_BEEPER_PORT:-23374}"
# Beeper's update feed: the latest build of a bundle for a platform, channel and architecture.
FEED="${ASSISTANT_BEEPER_FEED:-https://api.beeper.com/desktop/update-feed.json}"
# Where the owner's Beeper Desktop serves its Client API. Never this runtime's.
OWNER_PORT=23373
SERVER=/opt/beeper-server/beeper-server
UNIT=assistant-beeper.service
UNIT_FILE="$INSTALL_DIR/deploy/systemd/assistant-beeper.service"
# The assistant's own configuration: a .env with this runtime's address and,
# once it is signed up, its token. Outside the install, whose files the MCP
# service can read, and only the owner may open it.
CONFIG_DIR="${ASSISTANT_CONFIG_DIR:-$HOME/.config/claude-messenger/assistant}"
# Long enough for a slow first start on a small, busy host.
START_SECONDS=60
SELF="$(basename "$0")"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

RESET=0
case "${1:-}" in
  "") ;;
  --reset) RESET=1 ;;
  *) echo "usage: ${SELF} [--reset]" >&2; exit 2 ;;
esac

# The configuration directory belongs to the owner; the runtime has a user of its own.
[ "$(id -u)" -ne 0 ] || die "Run as the user who owns this install, not root."
case "$PORT" in
  "" | *[!0-9]*) die "ASSISTANT_BEEPER_PORT must be a port number, not '${PORT}'." ;;
esac
{ [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ]; } || die "ASSISTANT_BEEPER_PORT must be from 1024 to 65535, not ${PORT}."
[ "$PORT" -ne "$OWNER_PORT" ] ||
  die "port ${OWNER_PORT} is where the owner's Beeper Desktop answers; the assistant's runtime needs one of its own."
URL="http://127.0.0.1:${PORT}"

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

say "The assistant's configuration"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
ENV_FILE="$CONFIG_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  # umask first: it will hold the account's token, and must never exist readable by others.
  (umask 077 && printf 'BEEPER_BASE_URL=%s\n' "$URL" > "$ENV_FILE")
fi
chmod 600 "$ENV_FILE"
# Whatever the assistant's commands do, they do it to the runtime this names.
# Pointed anywhere else (the owner's Beeper Desktop, say), they must not run.
configured="$(env_value "$ENV_FILE" BEEPER_BASE_URL || true)"
# Unset, it is the default: the owner's Beeper Desktop.
[ -n "$configured" ] || configured="the owner's Beeper Desktop (the default, with no BEEPER_BASE_URL)"
[ "$configured" = "$URL" ] ||
  die "${ENV_FILE} points the assistant at ${configured}, not its own runtime at ${URL}. Set BEEPER_BASE_URL=${URL} there, then run ${SELF} again."
ok "${ENV_FILE} points at ${URL}"

# Only now: the checks above need no root.
sudo -n true 2>/dev/null || sudo -v ||
  die "this needs sudo, which it could not get; see above. Run ${SELF} where sudo can ask for your password, or let this user use sudo without one."

if [ "$RESET" -eq 1 ]; then
  say "Deleting the assistant's Beeper data"
  # The token would outlive the data it signed in, still working, with
  # nothing here able to sign it out. Reset is for a runtime no account was
  # kept on, such as one whose sign-up was refused.
  if env_value "$ENV_FILE" BEEPER_ACCESS_TOKEN >/dev/null; then
    die "the assistant's account is signed in here (its token is in ${ENV_FILE}). A reset would delete its keys and leave that token working; nothing was deleted."
  fi
  if systemctl cat "$UNIT" >/dev/null 2>&1; then
    sudo systemctl stop "$UNIT"
    sudo systemctl clean --what=state "$UNIT"
    ok "deleted; it starts again below, signed out"
  else
    ok "nothing to delete: it was never installed"
  fi
fi

say "Beeper Server (stable)"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "Beeper Server has no build for $(uname -m)." ;;
esac
feed_url="${FEED}?bundleID=com.automattic.beeper.server&platform=linux&channel=stable&arch=${ARCH}"
feed="$(curl -fsS --max-time 30 "$feed_url")" || die "Beeper's update feed did not answer: ${feed_url}"
# The feed names the latest stable build, where to get it and its SHA-512.
# Anything but a stable Linux Server build for this architecture is refused:
# a nightly build, a Desktop build, a version that isn't one.
# The reason for a refusal goes to stdout too, where only this script reads it.
build="$(printf '%s' "$feed" | node -e '
  let text = "";
  process.stdin.on("data", (c) => (text += c)).on("end", () => {
    const arch = process.argv[1];
    const refuse = (why) => { console.log(why); process.exit(1); };
    let feed;
    try { feed = JSON.parse(text); } catch { refuse("it is not JSON"); }
    const { version, url, sha512 } = feed ?? {};
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) refuse("it names no version");
    let artifact, file;
    try {
      artifact = new URL(url);
      file = decodeURIComponent(artifact.pathname.split("/").pop());
    } catch { refuse("it gives no download URL"); }
    if (artifact.protocol !== "https:" && artifact.protocol !== "http:") refuse("it gives no download URL");
    const expected = `beeper-server-${version}-linux-${arch}.tar.gz`;
    if (file !== expected) refuse(`its download is ${file}, not the stable build ${expected}`);
    if (typeof sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) refuse("it gives no SHA-512");
    console.log(`${version} ${artifact.href} ${sha512}`);
  });' "$ARCH")" || die "Beeper's update feed was refused: ${build}"
read -r VERSION ARTIFACT SHA512 <<<"$build"

# What runs now, if anything: Beeper reports its version at /v1/info.
running_version() {
  curl -fsS --max-time 5 "${URL}/v1/info" 2>/dev/null |
    node -e '
      let text = "";
      process.stdin.on("data", (c) => (text += c)).on("end", () => {
        try {
          const info = JSON.parse(text);
          if (info?.server?.port === Number(process.argv[1]) && typeof info?.app?.version === "string") {
            console.log(info.app.version);
            return;
          }
        } catch {}
        process.exit(1);
      });' "$PORT"
}
current=""
if systemctl cat "$UNIT" >/dev/null 2>&1; then
  # Started first, so a stopped server is updated like a running one, and
  # given time to answer: just started, it would look like no install at all.
  # One that won't start is no reason to stop here: the install below
  # replaces it, then proves it runs.
  sudo systemctl start "$UNIT" || true
  for _ in $(seq 1 "$START_SECONDS"); do
    current="$(running_version || true)"
    [ -z "$current" ] || break
    systemctl is-active --quiet "$UNIT" || break
    sleep 1
  done
fi

changed=0
if [ "$current" = "$VERSION" ]; then
  ok "Beeper Server ${VERSION} is the latest stable build, and running"
elif [ -n "$current" ] && [ "$(printf '%s\n%s\n' "$current" "$VERSION" | sort -V | tail -n 1)" = "$current" ]; then
  # Beeper's own data may not read with an older build.
  warn "Beeper Server ${current} runs, newer than the stable feed's ${VERSION}; kept."
  VERSION="$current"
else
  TMP="$(mktemp -d)"
  echo "Downloading Beeper Server ${VERSION}..."
  curl -fsSL --max-time 900 -o "$TMP/server.tar.gz" "$ARTIFACT" || die "the download of Beeper Server ${VERSION} failed: ${ARTIFACT}"
  actual="$(openssl dgst -sha512 -binary "$TMP/server.tar.gz" | openssl base64 -A)"
  [ "$actual" = "$SHA512" ] ||
    die "the download of Beeper Server ${VERSION} does not match the SHA-512 in Beeper's feed; nothing was installed."
  member="beeper-server-${VERSION}-linux-${ARCH}/beeper-server"
  tar -xzf "$TMP/server.tar.gz" -C "$TMP" "$member" 2>/dev/null && [ -f "$TMP/$member" ] && [ ! -L "$TMP/$member" ] ||
    die "the Beeper Server ${VERSION} download has no ${member}; nothing was installed."
  # install unlinks the old file first, so a server running from it keeps
  # running until the restart below.
  sudo install -D -m 0755 "$TMP/$member" "$SERVER"
  changed=1
  ok "Beeper Server ${VERSION} installed in ${SERVER%/*}"
fi

# SocketBindAllow and SocketBindDeny in the unit, which hold the server to its
# own port, need a systemd built with its BPF framework. One built without it,
# like Ubuntu 24.04's, quietly starts the unit without them; Ubuntu 26.04's has
# it. Say so, rather than let the gap pass unnoticed.
case "$(systemctl --version)" in
  *+BPF_FRAMEWORK*) ;;
  *) warn "this host's systemd was built without BPF, so it cannot hold Beeper Server to its own port: the server could listen on other ports, ${OWNER_PORT} too while the owner's Beeper Desktop is not running. The rest of its sandbox applies. Ubuntu 26.04's systemd has BPF; 24.04's does not." ;;
esac

unit_text="$(sed "s|__PORT__|${PORT}|g" "$UNIT_FILE")"
# `systemctl cat` prints the installed file after a line naming it.
if [ "$(systemctl cat "$UNIT" 2>/dev/null | tail -n +2)" != "$unit_text" ]; then
  printf '%s\n' "$unit_text" | sudo tee "/etc/systemd/system/$UNIT" >/dev/null
  sudo systemctl daemon-reload
  changed=1
fi
sudo systemctl enable "$UNIT"
if [ "$changed" -eq 1 ]; then
  # restart, not start: an update must swap the running process.
  sudo systemctl restart "$UNIT"
else
  sudo systemctl start "$UNIT"
fi

answering=0
for _ in $(seq 1 "$START_SECONDS"); do
  if [ "$(running_version || true)" = "$VERSION" ]; then
    answering=1
    break
  fi
  # A start that fails after the fork still reports success; the unit is then
  # no longer active, and waiting won't help.
  systemctl is-active --quiet "$UNIT" || break
  sleep 1
done
[ "$answering" -eq 1 ] || die "Beeper Server ${VERSION} is not answering on ${URL}. Check: sudo journalctl -u ${UNIT}"
ok "${UNIT}: Beeper Server ${VERSION} on ${URL}"

# Signed out, Beeper says so without a token; signed in, it wants one.
setup_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${URL}/v1/app/setup" || true)"
case "$setup_status" in
  401 | 403) ok "signed in to the assistant's account" ;;
  200) ok "not signed in to an account yet" ;;
  *) die "Beeper Server ${VERSION} would not say whether it is signed in (HTTP ${setup_status:-no answer}). Check: sudo journalctl -u ${UNIT}" ;;
esac
