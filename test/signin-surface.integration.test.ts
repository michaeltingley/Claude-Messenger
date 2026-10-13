import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost } from './fake-host.js';

/**
 * deploy/signin-surface.sh is the only thing that opens or closes Beeper's
 * sign-in surface (VNC of a signed-in Beeper == holding the account). These
 * tests run the real script as a subprocess against a fake host
 * (test/fake-host.ts): `tailscale`, `systemctl`, and `sudo` are shims on PATH
 * that model the real CLIs' exit codes and JSON over a state directory, and
 * reject any invocation they don't model.
 */

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'signin-surface.sh');
const UNITS = FakeHost.SURFACE_UNITS;

const surface = (host: FakeHost, ...args: string[]) => host.run(SCRIPT, args);

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
      const { code, stdout } = surface(host, 'up');

      expect(code).toBe(0);
      expect(host.has('serve-8443')).toBe(true);
      for (const unit of UNITS) expect(host.has(`active/${unit}`)).toBe(true);
      expect(stdout).toContain('https://box.example-tailnet.ts.net:8443/vnc.html');
      expect(surface(host, 'status').code).toBe(0);
    });

    it('is idempotent: reopening an open surface succeeds and reprints the URL', () => {
      surface(host, 'up');

      const again = surface(host, 'up');

      expect(again.code).toBe(0);
      expect(again.stdout).toContain('https://box.example-tailnet.ts.net:8443/vnc.html');
      expect(surface(host, 'status').code).toBe(0);
    });

    it('never enables the surface at boot, so a reboot always closes it', () => {
      surface(host, 'up');

      for (const unit of UNITS) expect(host.has(`enabled/${unit}`)).toBe(false);
      expect(host.calls().filter((c) => /\benable\b/.test(c))).toEqual([]);
    });

    it('refuses on a host that is not on a tailnet, without starting anything', () => {
      const offTailnet = new FakeHost();
      for (const unit of UNITS) offTailnet.set(`units/${unit}`);
      try {
        const { code, stderr } = surface(offTailnet, 'up');

        expect(code).not.toBe(0);
        expect(stderr).toContain('sudo tailscale up');
        expect(offTailnet.surfaceClosed()).toBe(true);
      } finally {
        offTailnet.dispose();
      }
    });

    it('refuses when the sign-in units were never installed, pointing at bootstrap', () => {
      const bare = new FakeHost().set('tailnet');
      try {
        const { code, stderr } = surface(bare, 'up');

        expect(code).not.toBe(0);
        expect(stderr).toContain('bootstrap.sh');
        expect(bare.has('serve-8443')).toBe(false);
      } finally {
        bare.dispose();
      }
    });

    it('mints an owner-only viewer password and prints a one-tap URL that carries it', () => {
      const { code, stdout } = surface(host, 'up');

      expect(code).toBe(0);
      const password = readFileSync(host.passwdFile, 'utf8').trim();
      expect(password).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(statSync(host.passwdFile).mode & 0o777).toBe(0o600);
      // In the fragment, which browsers never send to the server.
      expect(stdout).toContain(`https://box.example-tailnet.ts.net:8443/vnc.html#autoconnect=1&password=${password}`);
    });

    it('rotates the password on every opening, so an old link stops working', () => {
      const first = surface(host, 'up');
      const firstPassword = readFileSync(host.passwdFile, 'utf8').trim();

      const second = surface(host, 'up');
      const secondPassword = readFileSync(host.passwdFile, 'utf8').trim();

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(secondPassword).not.toBe(firstPassword);
      expect(second.stdout).toContain(`password=${secondPassword}`);
      expect(second.stdout).not.toContain(firstPassword);
      // restart, so a running x11vnc picks up the new password.
      expect(host.calls().filter((c) => c.startsWith('systemctl --user restart'))).toHaveLength(2);
    });

    it('opens nothing when the password cannot be minted', () => {
      // A broken runtime dir: where the password's directory should be, a file.
      writeFileSync(join(host.runtime, 'claude-messenger'), '');

      const { code, stderr } = surface(host, 'up');

      expect(code).not.toBe(0);
      expect(stderr).toContain('could not mint');
      expect(host.surfaceClosed()).toBe(true);
      expect(host.calls().filter((c) => /restart|serve --bg/.test(c))).toEqual([]);
    });

    it('closes everything it started when the tailnet refuses to publish, saying why', () => {
      host.set('fail-serve-on');

      const { code, stderr } = surface(host, 'up');

      expect(code).not.toBe(0);
      expect(stderr).toContain('could not publish the sign-in screen to the tailnet');
      expect(stderr).toContain('serve: access denied');
      expect(stderr).toContain("Then run 'signin-surface.sh up' again.");
      // Not reachable where it was meant to be, so not running anywhere, and no password left.
      expect(host.surfaceClosed()).toBe(true);
    });

    it('publishes when sudo asks the person at the terminal for a password first', () => {
      host.set('sudo-asks-password');

      const { code, stderr } = surface(host, 'up');

      expect(code, stderr).toBe(0);
      expect(host.has('serve-8443')).toBe(true);
    });

    it('says sudo wants a password, instead of hanging, when nobody can type one', () => {
      host.set('sudo-needs-password');

      const { code, stderr } = surface(host, 'up');

      expect(code).not.toBe(0);
      expect(stderr).toContain('sudo: a password is required');
      expect(host.surfaceClosed()).toBe(true);
    });

    it('stops waiting on a tailnet that has not allowed Tailscale Serve, and passes on the enable link', () => {
      host.set('serve-disabled');

      const started = Date.now();
      const { code, stderr } = host.run(SCRIPT, ['up'], { CLAUDE_MESSENGER_SERVE_TIMEOUT: '1' });

      expect(code).not.toBe(0);
      // tailscale itself would wait until someone allowed Serve.
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(stderr).toContain('Tailscale Serve is off on this tailnet');
      expect(stderr).toContain('https://login.tailscale.com/f/serve?node=nFAKE7');
      expect(host.surfaceClosed()).toBe(true);
    });
  });

  describe('down', () => {
    it('closes a fully exposed surface, including boot-enablement left by older installs', () => {
      host.exposeSurface();

      const { code, stdout } = surface(host, 'down');

      expect(code).toBe(0);
      expect(stdout).toContain('sign-in surface: down');
      expect(host.surfaceClosed()).toBe(true);
      expect(surface(host, 'status').code).toBe(1);
    });

    it('deletes the viewer password, so nothing is left to reopen the surface with', () => {
      surface(host, 'up');
      expect(existsSync(host.passwdFile)).toBe(true);

      const { code } = surface(host, 'down');

      expect(code).toBe(0);
      expect(existsSync(host.passwdFile)).toBe(false);
    });

    it('is idempotent: closing an already-closed surface succeeds without errors', () => {
      const first = surface(host, 'down');
      const second = surface(host, 'down');

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(second.stderr).toBe('');
      expect(host.surfaceClosed()).toBe(true);
    });

    it('succeeds on a host where the sign-in units were never installed', () => {
      const bare = new FakeHost().set('tailnet');
      try {
        const { code, stderr } = surface(bare, 'down');

        expect(code).toBe(0);
        expect(stderr).toBe('');
      } finally {
        bare.dispose();
      }
    });

    it('fails closed when the tailnet handler cannot be removed, naming the manual fix', () => {
      host.exposeSurface().set('fail-serve-off');

      const { code, stderr } = surface(host, 'down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toContain('published to the tailnet on :8443');
      expect(stderr).toContain('sudo tailscale serve --https 8443 off');
    });

    it('still unpublishes when reading the tailnet serve config needs root', () => {
      host.exposeSurface().set('serve-status-needs-root');

      const { code } = surface(host, 'down');

      expect(code).toBe(0);
      expect(host.surfaceClosed()).toBe(true);
    });

    it('fails closed when the tailnet serve config cannot be read at all', () => {
      host.set('serve-status-broken');

      const { code, stderr } = surface(host, 'down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toContain('unreadable');
      expect(host.calls()).toContain('sudo tailscale serve --https 8443 off');
    });

    it('fails closed when a unit keeps running after being told to stop', () => {
      host.exposeSurface().set('fail-stop');

      const { code, stderr } = surface(host, 'down');

      expect(code).not.toBe(0);
      expect(stderr).toContain('STILL exposed');
      expect(stderr).toMatch(/x11vnc\.service: running|novnc\.service: running/);
    });
  });

  describe('status', () => {
    it('reports a closed surface with exit 1, and each kind of exposure with exit 0', () => {
      expect(surface(host, 'status')).toMatchObject({ code: 1, stdout: 'sign-in surface: down\n' });

      for (const exposure of ['serve-8443', 'serve-status-broken', 'active/novnc.service', 'enabled/x11vnc.service']) {
        const exposed = FakeHost.provisioned().set(exposure);
        try {
          expect(surface(exposed, 'status').code, exposure).toBe(0);
        } finally {
          exposed.dispose();
        }
      }
    });
  });

  it('a full login cycle (up, then down) leaves nothing exposed and no password behind', () => {
    expect(surface(host, 'up').code).toBe(0);
    expect(surface(host, 'down').code).toBe(0);

    expect(host.surfaceClosed()).toBe(true);
    expect(existsSync(host.passwdFile)).toBe(false);
  });

  it('rejects an unknown subcommand with usage and exit 2', () => {
    const { code, stderr } = surface(host, 'open');

    expect(code).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
