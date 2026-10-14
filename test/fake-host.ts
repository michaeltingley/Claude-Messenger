import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake host for the deploy scripts. The real scripts run as subprocesses
 * with shims first on PATH for every CLI that would change a real machine:
 * `tailscale`, `systemctl`, `sudo`, `loginctl`, `apt-get`, `git`, `npm`,
 * `claude` and `id`. The shims model the real CLIs' exit codes and output
 * over a state directory, and reject any invocation they don't model (exit
 * 64), so a script can't drift to a CLI form these tests don't cover without
 * failing them. Everything else (node, curl, openssl, tar, timeout) is the
 * real thing, except that curl refuses the installers' downloads, and what
 * sudo writes under /etc and /opt lands in a fake root: a script under test
 * that goes wrong must fail, not install software on the machine running the
 * tests.
 *
 * `systemctl` runs a unit for real when its file is installed: under
 * ~/.config/systemd/user for the user manager, or under the fake root's
 * /etc/systemd/system for the system manager. Like systemd, it checks that
 * the paths the unit's sandbox names exist (ReadWritePaths, BindPaths,
 * BindReadOnlyPaths), then starts its ExecStart in WorkingDirectory, with
 * only the environment that manager gives its units. As for any Type=simple
 * unit, a start that fails after the fork (226/NAMESPACE, 217/USER; the
 * `sandbox-fails` flag forces one) still reports success: the unit is just
 * not active, and the reason is in its log. A system unit must name the
 * host's one user in User=, and changing system units takes root; the user
 * manager is reachable only with the user's XDG_RUNTIME_DIR, which sudo
 * drops. Like systemd, `start` leaves an active unit alone; only `restart`
 * swaps the process, and `enable` enables only a unit whose [Install]
 * section says where. Units that exist only as state flags (`units/<name>`)
 * are just marked active. A system unit may run under DynamicUser= instead
 * of the host's user, and gets the StateDirectory= it names, made before it
 * starts and deleted by `clean --what=state`. A system unit's paths under
 * /opt and /var/lib are the fake root's where root wrote there (sudo's
 * writes and state directories), and the machine's own otherwise, as node
 * may be. `cat` prints a unit's file after a line naming it, as the real one
 * does.
 *
 * `sudo` runs only the commands the scripts use, as that same user, but
 * every argument naming a path under /etc or /opt is moved into the fake
 * root, where root's writes land.
 */

const TAILSCALE_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "tailscale $*" >> "$S/calls.log"
# A tailnet that has not allowed Serve: tailscale prints an enable link and
# waits until someone opens it.
serve_disabled() {
  printf '\\nServe is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/serve?node=nFAKE7\\n\\n'
  exec sleep 600
}
case "$*" in
  "status") [ -e "$S/tailnet" ] ;;
  "status --json")
    [ -e "$S/tailnet" ] || exit 1
    printf '{\\n  "Self": {\\n    "DNSName": "box.example-tailnet.ts.net."\\n  }\\n}\\n' ;;
  "ip -4")
    [ -e "$S/tailnet" ] || exit 1
    echo "100.101.102.103" ;;
  "serve status --json")
    if [ -e "$S/serve-status-broken" ]; then echo "serve: internal error" >&2; exit 1; fi
    if [ -e "$S/serve-status-needs-root" ] && [ "\${FAKE_SUDO:-}" != 1 ]; then
      echo "serve: access denied" >&2; exit 1
    fi
    if [ -e "$S/serve-8443" ]; then
      printf '{\\n  "TCP": {\\n    "8443": {\\n      "HTTPS": true\\n    }\\n  },\\n  "Web": {\\n    "box.example-tailnet.ts.net:8443": {\\n      "Handlers": {\\n        "/": {\\n          "Proxy": "http://127.0.0.1:6080"\\n        }\\n      }\\n    }\\n  }\\n}\\n'
    else
      printf '{}\\n'
    fi ;;
  "serve --bg --https 8443 http://127.0.0.1:6080")
    [ -e "$S/serve-disabled" ] && serve_disabled
    if [ -e "$S/fail-serve-on" ]; then echo "serve: access denied" >&2; exit 1; fi
    touch "$S/serve-8443" ;;
  "serve --https 8443 off")
    if [ -e "$S/slow-serve-off" ]; then sleep 2; fi
    if [ -e "$S/fail-serve-off" ]; then echo "serve: failed" >&2; exit 1; fi
    rm -f "$S/serve-8443" ;;
  "serve --bg http://127.0.0.1:"[0-9]*)
    [ -e "$S/serve-disabled" ] && serve_disabled
    echo "\${3#http://127.0.0.1:}" > "$S/serve-443" ;;
  *) echo "fake tailscale: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

const SYSTEMCTL_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "systemctl $*" >> "$S/calls.log"
# The host's systemd version, as configure.sh reads it to decide whether the
# sandbox can get PrivatePIDs. A fresh runner is new enough (259, like the
# VPS); the \`systemd-version\` flag stands in for an older host.
if [ "\${1:-}" = "--version" ]; then
  v="$(cat "$S/systemd-version" 2>/dev/null || echo 259)"
  echo "systemd $v ($v.4-1ubuntu1)"
  exit 0
fi
if [ "\${1:-}" = "--user" ]; then
  shift
  scope=user; T="$S"; dir="$HOME/.config/systemd/user"
  # As root through sudo, say: sudo resets the environment.
  if [ -z "\${XDG_RUNTIME_DIR:-}" ]; then
    echo 'Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)' >&2
    exit 1
  fi
else
  scope=system; T="$S/system"; dir="$FAKE_HOST_ROOT/etc/systemd/system"
  # Anyone may read the system manager's state; changing it takes root.
  case "\${1:-}" in
    is-active|is-enabled|cat) ;;
    *) [ "\${FAKE_SUDO:-}" = 1 ] || { echo "Failed to \${1:-}: Interactive authentication required." >&2; exit 1; } ;;
  esac
fi
verb="$1"; shift
file_of() { printf '%s/%s' "$dir" "$1"; }
installed() { [ -e "$T/units/$1" ] || [ -e "$(file_of "$1")" ]; }
stop_unit() {
  local pid
  if [ -e "$T/pids/$1" ]; then
    pid="$(cat "$T/pids/$1")"
    kill -- "-$pid" 2>/dev/null || true
    rm -f "$T/pids/$1"
  fi
  rm -f "$T/active/$1"
}
# A Type=simple start that fails after the fork: the job still succeeds, the
# unit is just not active, and the journal says why.
failed_after_fork() {
  echo "$1: Main process exited, code=exited, status=$2" >> "$S/logs/$1.log"
  return 0
}
start_unit() {
  local u="$1" f wd cmd rw user
  # Like the real unit: x11vnc -passwdfile exits when the file is missing.
  if [ "$u" = x11vnc.service ] && [ ! -s "$XDG_RUNTIME_DIR/claude-messenger/vncpasswd" ]; then
    echo "Job for x11vnc.service failed (cannot open passwdfile)." >&2; return 1
  fi
  stop_unit "$u"
  f="$(file_of "$u")"
  if [ -e "$f" ] && grep -q '^ExecStart=' "$f"; then
    if [ "$(grep -c '^ExecStart=' "$f")" -gt 1 ]; then
      echo "Failed to $verb $u: Unit $u has a bad unit file setting." >&2; return 1
    fi
    if [ "$scope" = system ]; then
      user="$(sed -n 's/^User=//p' "$f" | tail -n 1)"
      case "$user" in
        "$FAKE_HOST_USER") ;;
        "")
          # A user of its own, made as it starts; here, it runs as the host's.
          if [ "$(sed -n 's/^DynamicUser=//p' "$f" | tail -n 1)" != yes ]; then
            echo "fake systemctl: $u names no User=, so it would run as root" >&2; return 1
          fi ;;
        *) failed_after_fork "$u" "217/USER"; return ;;
      esac
      if [ -e "$S/sandbox-fails" ]; then failed_after_fork "$u" "226/NAMESPACE"; return; fi
      for state in $(sed -n 's/^StateDirectory=//p' "$f"); do mkdir -p "$FAKE_HOST_ROOT/var/lib/$state"; done
    fi
    for key in ReadWritePaths BindPaths BindReadOnlyPaths; do
      for rw in $(sed -n "s/^$key=//p" "$f"); do
        # A leading - makes the path optional; a bind's source ends at a colon.
        case "$rw" in -*) continue ;; esac
        rw="\${rw%%:*}"
        if [ ! -e "$rw" ]; then failed_after_fork "$u" "226/NAMESPACE ($rw: No such file or directory)"; return; fi
      done
    done
    wd="$(sed -n 's/^WorkingDirectory=//p' "$f" | tail -n 1)"
    cmd="$(sed -n 's/^ExecStart=//p' "$f" | tail -n 1)"
    if [ "$scope" = system ]; then
      # What root put under /opt or /var/lib is the fake root's; anything else
      # there is the machine's own (node, say). A path may follow a flag's =.
      words=()
      for word in $cmd; do
        flag="\${word%%/*}"
        path="\${word#"$flag"}"
        case "$path" in
          /opt/* | /var/lib/*) [ -e "$FAKE_HOST_ROOT$path" ] && word="$flag$FAKE_HOST_ROOT$path" ;;
        esac
        words+=("$word")
      done
      cmd="\${words[*]}"
    fi
    # Its own process group, so stopping it stops everything it started. And
    # none of the caller's environment: a unit gets only its manager's, so
    # whatever it needs must come from its own config. Only the user manager
    # passes on XDG_RUNTIME_DIR.
    unit_env=(HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin)
    [ "$scope" = user ] && unit_env+=(XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR")
    ( cd "\${wd:-$HOME}" && exec env -i "\${unit_env[@]}" setsid $cmd ) >> "$S/logs/$u.log" 2>&1 < /dev/null &
    echo "$!" > "$T/pids/$u"
  fi
  touch "$T/active/$u"
}
case "$verb" in
  daemon-reload) ;;
  cat)
    if ! installed "$1"; then echo "No files found for $1." >&2; exit 1; fi
    if [ -e "$(file_of "$1")" ]; then
      printf '# %s\n' "$(file_of "$1")"
      cat "$(file_of "$1")"
    fi ;;
  is-active)
    [ "\${1:-}" = "--quiet" ] && shift
    [ -e "$T/active/$1" ] || exit 1
    # A Type=simple unit whose process has died is no longer active, though its
    # state flag lingers. Check the recorded leader pid is still alive, so a
    # caller that loops on is-active (configure.sh) sees a crash as the real
    # is-active would, instead of waiting out its whole timeout.
    [ ! -e "$T/pids/$1" ] || kill -0 "$(cat "$T/pids/$1")" 2>/dev/null ;;
  is-enabled) [ "$1" = "--quiet" ] && shift; [ -e "$T/enabled/$1" ] ;;
  start|restart)
    for u in "$@"; do
      if ! installed "$u"; then echo "Unit $u not found." >&2; exit 5; fi
    done
    for u in "$@"; do
      # An active unit is left alone; one whose process has died is not active.
      if [ "$verb" = start ] && [ -e "$T/active/$u" ] && { [ ! -e "$T/pids/$u" ] || kill -0 "$(cat "$T/pids/$u")" 2>/dev/null; }; then
        continue
      fi
      start_unit "$u" || exit 1
    done ;;
  enable)
    now=0
    if [ "\${1:-}" = "--now" ]; then now=1; shift; fi
    for u in "$@"; do
      if ! installed "$u"; then echo "Failed to enable unit: Unit file $u does not exist." >&2; exit 1; fi
      # Without an [Install] section that says where, enable is only a notice.
      if [ -e "$(file_of "$u")" ] && ! grep -q '^WantedBy=' "$(file_of "$u")"; then
        echo "The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=, Also=, or Alias= settings in the [Install] section, and DefaultInstance= for template units). This means they are not meant to be enabled or disabled using systemctl." >&2
      else
        touch "$T/enabled/$u"
      fi
      if [ "$now" = 1 ] && [ ! -e "$T/active/$u" ]; then start_unit "$u" || exit 1; fi
    done ;;
  stop)
    for u in "$@"; do
      if ! installed "$u"; then echo "Failed to stop $u: Unit $u not loaded." >&2; exit 5; fi
      stop_unit "$u"
    done ;;
  clean)
    # Only the form the scripts use: delete a unit's StateDirectory=.
    if [ "\${1:-}" != "--what=state" ] || [ $# -ne 2 ]; then
      echo "fake systemctl: unmodeled invocation: $verb $*" >&2; exit 64
    fi
    if ! installed "$2"; then echo "Failed to clean unit $2: Unit $2 not loaded." >&2; exit 5; fi
    if [ -e "$T/active/$2" ]; then
      echo "Failed to clean unit $2: Unit is not inactive or has pending job." >&2; exit 1
    fi
    for state in $(sed -n 's/^StateDirectory=//p' "$(file_of "$2")"); do rm -rf "$FAKE_HOST_ROOT/var/lib/$state"; done ;;
  disable)
    now=0
    if [ "\${1:-}" = "--now" ]; then now=1; shift; fi
    for u in "$@"; do
      if ! installed "$u"; then echo "Failed to disable unit: Unit file $u does not exist." >&2; exit 1; fi
      rm -f "$T/enabled/$u"
      if [ "$now" = 1 ]; then
        if [ -e "$S/fail-stop" ]; then echo "Failed to stop $u" >&2; exit 1; fi
        stop_unit "$u"
      fi
    done ;;
  *) echo "fake systemctl: unmodeled invocation: $verb $*" >&2; exit 64 ;;
esac
`;

// Real sudo as a cloud image sets it up: the user's own NOPASSWD rule runs
// every command without asking, but the image also puts the user in %sudo, a
// rule with a password, so -v asks (sudo's default, verifypw=all, wants every
// rule NOPASSWD), and there is no terminal to ask on. With
// \`sudo-needs-password\` every rule wants a password, with no terminal to ask
// on, as for a Claude session. With \`sudo-asks-password\` a person at a
// terminal types it when asked, and sudo then remembers it for a while; until
// then, -n fails. The command gets a reset environment, so only leading
// VAR=value assignments reach it (PATH stays, so it still finds the other
// shims). Only the commands and forms the scripts use run; paths under /etc
// and /opt move into the fake root.
const SUDO_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "sudo $*" >> "$S/calls.log"
no_terminal() {
  echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
  exit 1
}
if [ "$*" = "-v" ]; then
  [ -e "$S/sudo-needs-password" ] && no_terminal
  if [ -e "$S/sudo-asks-password" ]; then touch "$S/sudo-remembers"; exit 0; fi
  [ -e "$S/sudo-remembers" ] || no_terminal
  exit 0
fi
asks=1
if [ "\${1:-}" = "-n" ]; then asks=0; shift; fi
assign=()
while [ $# -gt 0 ] && [[ "$1" == [A-Z_]*=* ]]; do assign+=("$1"); shift; done
case "\${1:-}" in -*|"") echo "fake sudo: unmodeled invocation: $*" >&2; exit 64 ;; esac
# Root can write anywhere, so nothing else may run as root here. Installers
# piped in (bash -, sh) get only what the fake curl refuses to download.
case "$*" in
  true|"bash -"|sh|"systemctl "*|"tailscale "*|"apt-get "*|"loginctl "*) ;;
  "tee /etc/"*) [ $# -eq 2 ] || { echo "fake sudo: unmodeled invocation: $*" >&2; exit 64; } ;;
  # A file put in place under /opt, as an installer does.
  "install -D -m 0755 "*) [ $# -eq 6 ] && [[ "$6" == /opt/* ]] || { echo "fake sudo: unmodeled invocation: $*" >&2; exit 64; } ;;
  *) echo "fake sudo: unmodeled invocation: $*" >&2; exit 64 ;;
esac
if [ -e "$S/sudo-needs-password" ]; then
  [ "$asks" = 1 ] && no_terminal
  echo "sudo: a password is required" >&2; exit 1
fi
if [ -e "$S/sudo-asks-password" ] && [ ! -e "$S/sudo-remembers" ]; then
  [ "$asks" = 1 ] || { echo "sudo: a password is required" >&2; exit 1; }
  touch "$S/sudo-remembers"
fi
args=()
for arg in "$@"; do
  case "$arg" in /etc/* | /opt/*) args+=("$FAKE_HOST_ROOT$arg") ;; *) args+=("$arg") ;; esac
done
exec env -i PATH="$PATH" HOME="$HOME" FAKE_HOST_STATE="$S" FAKE_HOST_ROOT="$FAKE_HOST_ROOT" FAKE_HOST_USER="$FAKE_HOST_USER" \\
  FAKE_SUDO=1 "\${assign[@]}" "\${args[@]}"
`;

// Lingering lets a user's units run with nobody logged in; root only.
const LOGINCTL_SHIM = `#!/usr/bin/env bash
echo "loginctl $*" >> "$FAKE_HOST_STATE/calls.log"
if [ "\${1:-}" = enable-linger ] && [ $# -eq 2 ]; then
  if [ "\${FAKE_SUDO:-}" != 1 ]; then echo "Could not enable linger: Access denied" >&2; exit 1; fi
  touch "$FAKE_HOST_STATE/linger"; exit 0
fi
echo "fake loginctl: unmodeled invocation: $*" >&2; exit 64
`;

const APT_GET_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "apt-get $* [DEBIAN_FRONTEND=\${DEBIAN_FRONTEND:-} NEEDRESTART_MODE=\${NEEDRESTART_MODE:-}]" >> "$S/calls.log"
if [ "\${FAKE_SUDO:-}" != 1 ]; then echo "E: Could not open lock file - are you root?" >&2; exit 100; fi
# Without a terminal, debconf and needrestart prompts would wait forever.
if [ "\${DEBIAN_FRONTEND:-}" != noninteractive ] || [ "\${NEEDRESTART_MODE:-}" != a ]; then
  echo "fake apt-get: this would stop at a prompt nobody can answer" >&2; exit 65
fi
case "\${1:-}" in
  update) ;;
  install) [ "\${2:-}" = "-y" ] || { echo "fake apt-get: install without -y would prompt" >&2; exit 65; } ;;
  *) echo "fake apt-get: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

const GIT_SHIM = `#!/usr/bin/env bash
echo "git $*" >> "$FAKE_HOST_STATE/calls.log"
if [ "\${1:-}" = "-C" ] && [ -d "\${2:-}/.git" ] && [ "\${3:-} \${4:-}" = "pull --ff-only" ] && [ $# -eq 4 ]; then exit 0; fi
echo "fake git: unmodeled invocation: $*" >&2; exit 64
`;

const NPM_SHIM = `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_HOST_STATE/calls.log"
case "$*" in
  "ci --no-audit --no-fund"|"run build") ;;
  *) echo "fake npm: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

// Like the real CLI, \`mcp add\` echoes what it stored.
const CLAUDE_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "claude $1 $2" >> "$S/calls.log"
case "\${1:-} \${2:-}" in
  "mcp remove")
    if [ -e "$S/claude-mcp" ]; then rm -f "$S/claude-mcp"; echo "Removed MCP server $3"; exit 0; fi
    echo "No MCP server found with name: $3" >&2; exit 1 ;;
  "mcp add")
    shift 2
    printf '%s\\n' "$@" > "$S/claude-mcp"
    echo "Added MCP server with: $*" ;;
  *) echo "fake claude: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

const curlShim = (realCurl: string) => `#!/usr/bin/env bash
case "$*" in
  *api.beeper.com*|*deb.nodesource.com*|*tailscale.com/install.sh*)
    echo "fake curl: a fake host downloads no installers: $*" >&2; exit 64 ;;
esac
exec ${realCurl} "$@"
`;

// A regular user's host, whoever runs the tests; root with the \`root\` flag,
// and under sudo.
const ID_SHIM = `#!/usr/bin/env bash
root=0; [ -e "$FAKE_HOST_STATE/root" ] || [ "\${FAKE_SUDO:-}" = 1 ] && root=1
case "$*" in
  -u) if [ "$root" = 1 ]; then echo 0; else echo 1000; fi ;;
  -un) if [ "$root" = 1 ]; then echo root; else echo "$FAKE_HOST_USER"; fi ;;
  *) echo "fake id: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DetachedRun {
  child: ChildProcess;
  /** Everything it has printed so far. */
  output(): string;
  running(): boolean;
  done: Promise<ScriptResult>;
}

export class FakeHost {
  readonly root = mkdtempSync(join(tmpdir(), 'fake-host-'));
  private readonly bin = join(this.root, 'bin');
  readonly state = join(this.root, 'state');
  /** $HOME for every script run here. */
  readonly home = join(this.root, 'home');
  /** The user's runtime dir ($XDG_RUNTIME_DIR, /run/user/UID on a real host). */
  readonly runtime = join(this.root, 'runtime');
  readonly passwdFile = join(this.runtime, 'claude-messenger', 'vncpasswd');
  readonly unitDir = join(this.home, '.config', 'systemd', 'user');
  /** Where root's writes under /etc land (see the sudo shim). */
  readonly sysroot = join(this.root, 'sysroot');
  readonly systemUnitDir = join(this.sysroot, 'etc', 'systemd', 'system');
  /** The host's one user, as `id -un` names it. */
  static readonly USER = 'owner';
  private readonly detached: ChildProcess[] = [];

  constructor() {
    for (const dir of [
      this.bin,
      this.home,
      this.systemUnitDir,
      join(this.state, 'logs'),
      // The user manager's state, and the system manager's.
      ...['units', 'active', 'enabled', 'pids'].flatMap((d) => [join(this.state, d), join(this.state, 'system', d)]),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(this.runtime, { mode: 0o700 });
    for (const [name, body] of [
      ['tailscale', TAILSCALE_SHIM],
      ['systemctl', SYSTEMCTL_SHIM],
      ['sudo', SUDO_SHIM],
      ['loginctl', LOGINCTL_SHIM],
      ['apt-get', APT_GET_SHIM],
      ['git', GIT_SHIM],
      ['npm', NPM_SHIM],
      ['claude', CLAUDE_SHIM],
      ['id', ID_SHIM],
      ['curl', curlShim(spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim())],
    ] as const) {
      writeFileSync(join(this.bin, name), body);
      chmodSync(join(this.bin, name), 0o755);
    }
    writeFileSync(join(this.state, 'calls.log'), '');
  }

  /** The Beeper sign-in surface's units (deploy/signin-surface.sh). */
  static readonly SURFACE_UNITS = ['x11vnc.service', 'novnc.service'] as const;

  /** A host bootstrap provisioned and joined to a tailnet, sign-in surface closed. */
  static provisioned(): FakeHost {
    const host = new FakeHost().set('tailnet');
    for (const unit of FakeHost.SURFACE_UNITS) host.set(`units/${unit}`);
    return host;
  }

  set(flag: string, content = ''): this {
    writeFileSync(join(this.state, flag), content);
    return this;
  }

  has(flag: string): boolean {
    return existsSync(join(this.state, flag));
  }

  read(flag: string): string {
    return readFileSync(join(this.state, flag), 'utf8');
  }

  calls(): string[] {
    return readFileSync(join(this.state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  }

  /** What every unit the fake systemd started has printed, for a failing test's message. */
  logs(): string {
    const dir = join(this.state, 'logs');
    return readdirSync(dir)
      .map((log) => `--- ${log}\n${readFileSync(join(dir, log), 'utf8')}`)
      .join('\n');
  }

  /** The sign-in surface published, running, AND enabled at boot (as on hosts older than the script). */
  exposeSurface(): this {
    this.set('serve-8443');
    for (const unit of FakeHost.SURFACE_UNITS) this.set(`active/${unit}`).set(`enabled/${unit}`);
    return this;
  }

  /** Nothing of the sign-in surface published, running, or enabled, and no password left. */
  surfaceClosed(): boolean {
    return (
      !this.has('serve-8443') &&
      !existsSync(this.passwdFile) &&
      FakeHost.SURFACE_UNITS.every((u) => !this.has(`active/${u}`) && !this.has(`enabled/${u}`))
    );
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    // The test runner's own configuration must not leak into the host's.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(BEEPER_|CLAUDE_MESSENGER_)/.test(name)),
    );
    return {
      ...inherited,
      PATH: `${this.bin}:${process.env.PATH}`,
      HOME: this.home,
      FAKE_HOST_STATE: this.state,
      FAKE_HOST_ROOT: this.sysroot,
      FAKE_HOST_USER: FakeHost.USER,
      XDG_RUNTIME_DIR: this.runtime,
      ...extra,
    };
  }

  /** Run a script to completion, for scripts that need nothing from this process meanwhile. */
  run(script: string, args: string[] = [], extra: Record<string, string> = {}): ScriptResult {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: this.env(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
      // A backstop: a hang should fail the test, not stall the run.
      timeout: 60_000,
    });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Run a script the way a Claude session does: no terminal at all (a new
   * session, so /dev/tty can't be opened) and nothing on stdin. Async, so a
   * server in this process (the mock Beeper) can answer it meanwhile.
   */
  runDetached(command: string, args: string[] = [], extra: Record<string, string> = {}): Promise<ScriptResult> {
    return this.startDetached(command, args, extra).done;
  }

  /**
   * `runDetached`, handing back the running script too, for tests that act
   * on it meanwhile. Its pid leads its own process group, as a background
   * command's does.
   */
  startDetached(command: string, args: string[] = [], extra: Record<string, string> = {}): DetachedRun {
    const child = spawn(command, args, { env: this.env(extra), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.detached.push(child);
    let stdout = '';
    let stderr = '';
    let running = true;
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const done = new Promise<ScriptResult>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        running = false;
        resolve({ code: code ?? (signal ? 128 : -1), stdout, stderr });
      });
    });
    return { child, output: () => stdout + stderr, running: () => running, done };
  }

  /** Stop every unit the fake systemd started, under either manager. */
  stopUnits(): void {
    for (const pids of [join(this.state, 'pids'), join(this.state, 'system', 'pids')]) {
      for (const unit of readdirSync(pids)) {
        const pid = Number(readFileSync(join(pids, unit), 'utf8'));
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
  }

  /** Stop everything this host started, including scripts a failed test left running. */
  dispose(): void {
    for (const child of this.detached) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    this.stopUnits();
    rmSync(this.root, { recursive: true, force: true });
  }
}
