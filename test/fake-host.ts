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
 * failing them. Everything else (node, curl, openssl, timeout) is the real
 * thing, except that curl refuses the installers' downloads and sudo refuses
 * /opt: a script under test that goes wrong must fail, not install software
 * on the machine running the tests.
 *
 * `systemctl` runs a unit for real when its file is installed under
 * ~/.config/systemd/user: it checks the unit's ReadWritePaths exist, as
 * systemd does, then starts its ExecStart in WorkingDirectory, with only the
 * environment a user manager gives its units. Like systemd, `start` leaves an
 * active unit alone; only `restart` swaps the process. Units that exist only
 * as state flags (`units/<name>`) are just marked active.
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
if [ "\${1:-}" != "--user" ]; then echo "fake systemctl: only --user is modeled" >&2; exit 64; fi
shift
verb="$1"; shift
file_of() { printf '%s/.config/systemd/user/%s' "$HOME" "$1"; }
installed() { [ -e "$S/units/$1" ] || [ -e "$(file_of "$1")" ]; }
stop_unit() {
  local pid
  if [ -e "$S/pids/$1" ]; then
    pid="$(cat "$S/pids/$1")"
    kill -- "-$pid" 2>/dev/null || true
    rm -f "$S/pids/$1"
  fi
  rm -f "$S/active/$1"
}
start_unit() {
  local u="$1" f wd cmd rw
  # Like the real unit: x11vnc -passwdfile exits when the file is missing.
  if [ "$u" = x11vnc.service ] && [ ! -s "$XDG_RUNTIME_DIR/claude-messenger/vncpasswd" ]; then
    echo "Job for x11vnc.service failed (cannot open passwdfile)." >&2; return 1
  fi
  stop_unit "$u"
  f="$(file_of "$u")"
  if [ -e "$f" ] && grep -q '^ExecStart=' "$f"; then
    for rw in $(sed -n 's/^ReadWritePaths=//p' "$f"); do
      if [ ! -e "$rw" ]; then
        echo "Job for $u failed: $u: Failed to set up mount namespacing: $rw: No such file or directory (226/NAMESPACE)" >&2
        return 1
      fi
    done
    wd="$(sed -n 's/^WorkingDirectory=//p' "$f" | tail -n 1)"
    cmd="$(sed -n 's/^ExecStart=//p' "$f" | tail -n 1)"
    # Its own process group, so stopping it stops everything it started. And
    # none of the caller's environment: a unit gets the user manager's, so
    # whatever it needs must come from its own config.
    ( cd "\${wd:-$HOME}" &&
      exec env -i HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" PATH=/usr/local/bin:/usr/bin:/bin setsid $cmd
    ) >> "$S/logs/$u.log" 2>&1 < /dev/null &
    echo "$!" > "$S/pids/$u"
  fi
  touch "$S/active/$u"
}
case "$verb" in
  daemon-reload) ;;
  cat) installed "$1" ;;
  is-active) [ "$1" = "--quiet" ] && shift; [ -e "$S/active/$1" ] ;;
  is-enabled) [ "$1" = "--quiet" ] && shift; [ -e "$S/enabled/$1" ] ;;
  start|restart)
    for u in "$@"; do
      if ! installed "$u"; then echo "Unit $u not found." >&2; exit 5; fi
    done
    for u in "$@"; do
      if [ "$verb" = start ] && [ -e "$S/active/$u" ]; then continue; fi
      start_unit "$u" || exit 1
    done ;;
  enable)
    now=0
    if [ "\${1:-}" = "--now" ]; then now=1; shift; fi
    for u in "$@"; do
      if ! installed "$u"; then echo "Failed to enable unit: Unit file $u does not exist." >&2; exit 1; fi
      touch "$S/enabled/$u"
      if [ "$now" = 1 ] && [ ! -e "$S/active/$u" ]; then start_unit "$u" || exit 1; fi
    done ;;
  disable)
    now=0
    if [ "\${1:-}" = "--now" ]; then now=1; shift; fi
    for u in "$@"; do
      if ! installed "$u"; then echo "Failed to disable unit: Unit file $u does not exist." >&2; exit 1; fi
      rm -f "$S/enabled/$u"
      if [ "$now" = 1 ]; then
        if [ -e "$S/fail-stop" ]; then echo "Failed to stop $u" >&2; exit 1; fi
        stop_unit "$u"
      fi
    done ;;
  *) echo "fake systemctl: unmodeled invocation: $verb $*" >&2; exit 64 ;;
esac
`;

// Real sudo with a NOPASSWD ALL rule: -v validates, -n never asks, and the
// command gets a reset environment, so only leading VAR=value assignments
// reach it (PATH stays, so it still finds the other shims). With the
// \`sudo-needs-password\` flag it is a rule that wants a password, with no
// terminal to ask on, as for a Claude session. With \`sudo-asks-password\`
// a person at a terminal types it when asked, and sudo then remembers it for
// a while; until then, -n fails.
const SUDO_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "sudo $*" >> "$S/calls.log"
no_terminal() {
  echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
  exit 1
}
if [ "$*" = "-v" ]; then
  [ -e "$S/sudo-needs-password" ] && no_terminal
  [ -e "$S/sudo-asks-password" ] && touch "$S/sudo-remembers"
  exit 0
fi
asks=1
if [ "\${1:-}" = "-n" ]; then asks=0; shift; fi
assign=()
while [ $# -gt 0 ] && [[ "$1" == [A-Z_]*=* ]]; do assign+=("$1"); shift; done
case "\${1:-}" in -*|"") echo "fake sudo: unmodeled invocation: $*" >&2; exit 64 ;; esac
case " $* " in *" /opt"*) echo "fake sudo: a fake host has no /opt to install into: $*" >&2; exit 64 ;; esac
if [ -e "$S/sudo-needs-password" ]; then
  [ "$asks" = 1 ] && no_terminal
  echo "sudo: a password is required" >&2; exit 1
fi
if [ -e "$S/sudo-asks-password" ] && [ ! -e "$S/sudo-remembers" ]; then
  [ "$asks" = 1 ] || { echo "sudo: a password is required" >&2; exit 1; }
  touch "$S/sudo-remembers"
fi
exec env -i PATH="$PATH" HOME="$HOME" FAKE_HOST_STATE="$S" FAKE_SUDO=1 "\${assign[@]}" "$@"
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

// A regular user's host, whoever runs the tests; root with the \`root\` flag.
const ID_SHIM = `#!/usr/bin/env bash
if [ "$*" = "-u" ]; then if [ -e "$FAKE_HOST_STATE/root" ]; then echo 0; else echo 1000; fi; exit 0; fi
echo "fake id: unmodeled invocation: $*" >&2; exit 64
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
  private readonly detached: ChildProcess[] = [];

  constructor() {
    for (const dir of [
      this.bin,
      this.home,
      ...['units', 'active', 'enabled', 'pids', 'logs'].map((d) => join(this.state, d)),
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

  set(flag: string): this {
    writeFileSync(join(this.state, flag), '');
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

  /** Stop every unit the fake systemd started. */
  stopUnits(): void {
    for (const unit of readdirSync(join(this.state, 'pids'))) {
      const pid = Number(readFileSync(join(this.state, 'pids', unit), 'utf8'));
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // already gone
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
