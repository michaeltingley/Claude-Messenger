import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/signin-surface.sh is the only thing that opens or closes Beeper's
 * sign-in surface (VNC of a signed-in Beeper == holding the account). These
 * tests run the real script as a subprocess against a fake host: `tailscale`,
 * `systemctl`, and `sudo` are shims on PATH that model the real CLIs' exit
 * codes and JSON over a state directory. A shim rejects any invocation it
 * doesn't model (exit 64), so the script can't drift to a CLI form these
 * tests don't cover without failing them.
 */

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'signin-surface.sh');
const UNITS = ['x11vnc.service', 'novnc.service'] as const;

const TAILSCALE_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "tailscale $*" >> "$S/calls.log"
case "$*" in
  "status") [ -e "$S/tailnet" ] ;;
  "status --json")
    [ -e "$S/tailnet" ] || exit 1
    printf '{\\n  "Self": {\\n    "DNSName": "box.example-tailnet.ts.net."\\n  }\\n}\\n' ;;
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
    if [ -e "$S/fail-serve-on" ]; then echo "serve: access denied" >&2; exit 1; fi
    touch "$S/serve-8443" ;;
  "serve --https 8443 off")
    if [ -e "$S/fail-serve-off" ]; then echo "serve: failed" >&2; exit 1; fi
    rm -f "$S/serve-8443" ;;
  *) echo "fake tailscale: unmodeled invocation: $*" >&2; exit 64 ;;
esac
`;

const SYSTEMCTL_SHIM = `#!/usr/bin/env bash
S="$FAKE_HOST_STATE"
echo "systemctl $*" >> "$S/calls.log"
if [ "\${1:-}" != "--user" ]; then echo "fake systemctl: only --user is modeled" >&2; exit 64; fi
shift
verb="$1"; shift
case "$verb" in
  cat) [ -e "$S/units/$1" ] ;;
  is-active) [ "$1" = "--quiet" ] && shift; [ -e "$S/active/$1" ] ;;
  is-enabled) [ "$1" = "--quiet" ] && shift; [ -e "$S/enabled/$1" ] ;;
  start)
    for u in "$@"; do
      if [ ! -e "$S/units/$u" ]; then echo "Unit $u not found." >&2; exit 5; fi
    done
    for u in "$@"; do touch "$S/active/$u"; done ;;
  disable)
    now=0
    if [ "\${1:-}" = "--now" ]; then now=1; shift; fi
    for u in "$@"; do
      if [ ! -e "$S/units/$u" ]; then echo "Failed to disable unit: Unit file $u does not exist." >&2; exit 1; fi
      rm -f "$S/enabled/$u"
      if [ "$now" = 1 ]; then
        if [ -e "$S/fail-stop" ]; then echo "Failed to stop $u" >&2; exit 1; fi
        rm -f "$S/active/$u"
      fi
    done ;;
  *) echo "fake systemctl: unmodeled invocation: $verb $*" >&2; exit 64 ;;
esac
`;

const SUDO_SHIM = `#!/usr/bin/env bash
echo "sudo $*" >> "$FAKE_HOST_STATE/calls.log"
FAKE_SUDO=1 exec "$@"
`;

class FakeHost {
  readonly root = mkdtempSync(join(tmpdir(), 'signin-surface-'));
  private readonly bin = join(this.root, 'bin');
  readonly state = join(this.root, 'state');

  constructor() {
    for (const dir of [this.bin, this.state, ...['units', 'active', 'enabled'].map((d) => join(this.state, d))]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const [name, body] of [
      ['tailscale', TAILSCALE_SHIM],
      ['systemctl', SYSTEMCTL_SHIM],
      ['sudo', SUDO_SHIM],
    ] as const) {
      writeFileSync(join(this.bin, name), body);
      chmodSync(join(this.bin, name), 0o755);
    }
    writeFileSync(join(this.state, 'calls.log'), '');
  }

  /** A host that bootstrap provisioned and joined to a tailnet, surface closed. */
  static provisioned(): FakeHost {
    const host = new FakeHost();
    host.set('tailnet');
    for (const unit of UNITS) host.set(`units/${unit}`);
    return host;
  }

  set(flag: string): this {
    writeFileSync(join(this.state, flag), '');
    return this;
  }

  has(flag: string): boolean {
    return existsSync(join(this.state, flag));
  }

  /** Everything published, running, AND enabled at boot (pre-script hosts). */
  exposeEverything(): this {
    this.set('serve-8443');
    for (const unit of UNITS) this.set(`active/${unit}`).set(`enabled/${unit}`);
    return this;
  }

  calls(): string[] {
    return readFileSync(join(this.state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  }

  run(...args: string[]): { code: number; stdout: string; stderr: string } {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${this.bin}:${process.env.PATH}`, FAKE_HOST_STATE: this.state },
    });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** Nothing published, nothing running, nothing enabled. */
  fullyClosed(): boolean {
    return !this.has('serve-8443') && UNITS.every((u) => !this.has(`active/${u}`) && !this.has(`enabled/${u}`));
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe('deploy/signin-surface.sh (subprocess against a fake host)', () => {
  let host: FakeHost;

  beforeEach(() => {
    host = FakeHost.provisioned();
  });

  afterEach(() => {
    host.dispose();
  });

  describe('up', () => {
    it('starts the loopback pair and publishes it to the tailnet, printing the noVNC URL', () => {
      const { code, stdout } = host.run('up');

      expect(code).toBe(0);
      expect(host.has('serve-8443')).toBe(true);
      for (const unit of UNITS) expect(host.has(`active/${unit}`)).toBe(true);
      expect(stdout).toContain('https://box.example-tailnet.ts.net:8443/vnc.html');
      expect(host.run('status').code).toBe(0);
    });

    it('is idempotent: reopening an open surface succeeds and reprints the URL', () => {
      host.run('up');

      const again = host.run('up');

      expect(again.code).toBe(0);
      expect(again.stdout).toContain('https://box.example-tailnet.ts.net:8443/vnc.html');
      expect(host.run('status').code).toBe(0);
    });

    it('never enables the surface at boot, so a reboot always closes it', () => {
      host.run('up');

      for (const unit of UNITS) expect(host.has(`enabled/${unit}`)).toBe(false);
      expect(host.calls().filter((c) => /\benable\b/.test(c))).toEqual([]);
    });

    it('refuses on a host that is not on a tailnet, without starting anything', () => {
      const offTailnet = new FakeHost();
      for (const unit of UNITS) offTailnet.set(`units/${unit}`);
      try {
        const { code, stderr } = offTailnet.run('up');

        expect(code).not.toBe(0);
        expect(stderr).toContain('sudo tailscale up');
        expect(offTailnet.fullyClosed()).toBe(true);
      } finally {
        offTailnet.dispose();
      }
    });

    it('refuses when the sign-in units were never installed, pointing at bootstrap', () => {
      const bare = new FakeHost().set('tailnet');
      try {
        const { code, stderr } = bare.run('up');

        expect(code).not.toBe(0);
        expect(stderr).toContain('bootstrap.sh');
        expect(bare.has('serve-8443')).toBe(false);
      } finally {
        bare.dispose();
      }
    });

    it('fails loudly with an SSH-tunnel fallback when the tailnet refuses to publish', () => {
      host.set('fail-serve-on');

      const { code, stderr } = host.run('up');

      expect(code).not.toBe(0);
      expect(stderr).toContain('ssh -L 6080:127.0.0.1:6080');
      expect(host.has('serve-8443')).toBe(false);
    });
  });

  describe('down', () => {
    it('closes a fully exposed surface, including boot-enablement left by older installs', () => {
      host.exposeEverything();

      const { code, stdout } = host.run('down');

      expect(code).toBe(0);
      expect(stdout).toContain('sign-in surface: down');
      expect(host.fullyClosed()).toBe(true);
      expect(host.run('status').code).toBe(1);
    });

    it('is idempotent: closing an already-closed surface succeeds without errors', () => {
      const first = host.run('down');
      const second = host.run('down');

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(second.stderr).toBe('');
      expect(host.fullyClosed()).toBe(true);
    });

    it('succeeds on a host where the sign-in units were never installed', () => {
      const bare = new FakeHost().set('tailnet');
      try {
        const { code, stderr } = bare.run('down');

        expect(code).toBe(0);
        expect(stderr).toBe('');
      } finally {
        bare.dispose();
      }
    });

    it('fails closed when the tailnet handler cannot be removed, naming the manual fix', () => {
      host.exposeEverything().set('fail-serve-off');

      const { code, stderr } = host.run('down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toContain('published to the tailnet on :8443');
      expect(stderr).toContain('sudo tailscale serve --https 8443 off');
    });

    it('still unpublishes when reading the tailnet serve config needs root', () => {
      host.exposeEverything().set('serve-status-needs-root');

      const { code } = host.run('down');

      expect(code).toBe(0);
      expect(host.fullyClosed()).toBe(true);
    });

    it('fails closed when the tailnet serve config cannot be read at all', () => {
      host.set('serve-status-broken');

      const { code, stderr } = host.run('down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toContain('unreadable');
      expect(host.calls()).toContain('sudo tailscale serve --https 8443 off');
    });

    it('fails closed when a unit keeps running after being told to stop', () => {
      host.exposeEverything().set('fail-stop');

      const { code, stderr } = host.run('down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toMatch(/x11vnc\.service: running|novnc\.service: running/);
    });
  });

  describe('status', () => {
    it('reports a closed surface with exit 1, and each kind of exposure with exit 0', () => {
      expect(host.run('status')).toMatchObject({ code: 1, stdout: 'sign-in surface: down\n' });

      for (const exposure of ['serve-8443', 'serve-status-broken', 'active/novnc.service', 'enabled/x11vnc.service']) {
        const exposed = FakeHost.provisioned().set(exposure);
        try {
          expect(exposed.run('status').code, exposure).toBe(0);
        } finally {
          exposed.dispose();
        }
      }
    });
  });

  it('a full login cycle (up, then down) leaves nothing exposed', () => {
    expect(host.run('up').code).toBe(0);
    expect(host.run('down').code).toBe(0);

    expect(host.fullyClosed()).toBe(true);
  });

  it('rejects an unknown subcommand with usage and exit 2', () => {
    const { code, stderr } = host.run('open');

    expect(code).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
