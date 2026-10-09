import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * On a shared host (docs/SHARED-HOST.md), loopback and the X socket are
 * reachable by every local user. These tests start the real Xvfb and x11vnc
 * exactly as deploy/systemd/ runs them, then speak the real X11 and RFB
 * handshakes to prove that neither one admits a client without its secret.
 * A config check alone would not prove that.
 *
 * The binaries are installed in CI. Locally, the suite skips when they're
 * missing, but in CI a missing binary fails it instead of passing vacuously.
 */

const SYSTEMD = join(import.meta.dirname, '..', 'deploy', 'systemd');
const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const toolsPresent = ['Xvfb', 'xauth', 'mcookie', 'x11vnc'].every(has);
if (!toolsPresent && process.env.CI) throw new Error('CI must install xvfb, xauth and x11vnc for these tests');

/** A unit's Exec*= command line, with systemd's specifiers expanded the way a real host would. */
function execLine(unit: string, key: 'ExecStartPre' | 'ExecStart', runtimeDir: string, display: number): string {
  const line = readFileSync(join(SYSTEMD, unit), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${unit} has no ${key}=`);
  return line
    .slice(key.length + 1)
    .replaceAll('%t', runtimeDir)
    .replaceAll('$$', '$')
    .replaceAll(':99', `:${display}`);
}

function freeDisplay(): number {
  for (let n = 150 + Math.floor(Math.random() * 50); n < 250; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('no free X display');
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    if (check()) return true;
  }
  return check();
}

/** X11 connection setup. Resolves the server's status byte: 1 = accepted, 0 = refused. */
function xHandshake(display: number, cookieHex?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(`/tmp/.X11-unix/X${display}`);
    socket.on('connect', () => {
      const name = Buffer.from(cookieHex ? 'MIT-MAGIC-COOKIE-1' : '');
      const data = Buffer.from(cookieHex ?? '', 'hex');
      const pad = (n: number) => Buffer.alloc((4 - (n % 4)) % 4);
      const header = Buffer.alloc(12);
      header.write('l', 0); // little-endian
      header.writeUInt16LE(11, 2); // protocol 11.0
      header.writeUInt16LE(name.length, 6);
      header.writeUInt16LE(data.length, 8);
      socket.write(Buffer.concat([header, name, pad(name.length), data, pad(data.length)]));
    });
    socket.once('data', (reply) => {
      socket.destroy();
      resolve(reply[0] ?? -1);
    });
    socket.on('error', reject);
  });
}

/** RFB 3.8 handshake up to the security-type list the server offers (1 = None, 2 = VNC password). */
function rfbSecurityTypes(port: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let versionSent = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!versionSent && buffer.length >= 12) {
        socket.write('RFB 003.008\n');
        versionSent = true;
        buffer = buffer.subarray(12);
      }
      const count = buffer[0];
      if (versionSent && count !== undefined && buffer.length >= 1 + count) {
        socket.destroy();
        resolve([...buffer.subarray(1, 1 + count)]);
      }
    });
    socket.on('error', reject);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
  });
}

describe.skipIf(!toolsPresent)('Beeper display isolation (real Xvfb + x11vnc from deploy/systemd)', () => {
  let runtimeDir: string;
  let display: number;
  const children: ChildProcess[] = [];

  const launch = (commandLine: string): ChildProcess => {
    const child = spawn('sh', ['-c', `exec ${commandLine}`], { stdio: 'ignore' });
    children.push(child);
    return child;
  };

  beforeEach(async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'runtime-'));
    display = freeDisplay();
    const pre = spawnSync('sh', ['-c', execLine('xvfb.service', 'ExecStartPre', runtimeDir, display)], {
      encoding: 'utf8',
    });
    expect(pre.status, pre.stderr).toBe(0);
    launch(execLine('xvfb.service', 'ExecStart', runtimeDir, display));
    expect(await until(() => existsSync(`/tmp/.X11-unix/X${display}`), 10_000)).toBe(true);
  });

  afterEach(async () => {
    // SIGTERM and wait, so Xvfb removes its /tmp/.X<n>-lock on the way out.
    await Promise.all(
      children.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
          }),
      ),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  const cookie = (): string => {
    const listed = spawnSync('xauth', ['-f', join(runtimeDir, 'claude-messenger', 'xauth'), 'list'], {
      encoding: 'utf8',
    }).stdout;
    const hex = /MIT-MAGIC-COOKIE-1\s+([0-9a-f]{32})/.exec(listed)?.[1];
    if (!hex) throw new Error(`no cookie minted: ${listed}`);
    return hex;
  };

  it('the display refuses an X client without its cookie, and admits one holding it', async () => {
    expect(await xHandshake(display)).toBe(0);
    expect(await xHandshake(display, '00'.repeat(16))).toBe(0);
    expect(await xHandshake(display, cookie())).toBe(1);
  }, 20_000);

  it('the cookie is readable only by its owner', () => {
    const file = join(runtimeDir, 'claude-messenger', 'xauth');
    const mode = spawnSync('stat', ['-c', '%a', file], { encoding: 'utf8' }).stdout.trim();

    expect(mode).toBe('600');
  });

  it('with a password file, the VNC hop offers password auth and never "None"', async () => {
    writeFileSync(join(runtimeDir, 'claude-messenger', 'vncpasswd'), 'Pw7xQ2kz\n', { mode: 0o600 });
    const port = await freePort();
    launch(execLine('x11vnc.service', 'ExecStart', runtimeDir, display).replace('-rfbport 5900', `-rfbport ${port}`));

    let offered: number[] = [];
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && offered.length === 0; ) {
      offered = await rfbSecurityTypes(port).catch(() => []);
      if (offered.length === 0) await new Promise((r) => setTimeout(r, 250));
    }

    expect(offered).toEqual([2]);
  }, 30_000);

  it('without a password file, the VNC hop does not start at all', async () => {
    const port = await freePort();
    const x11vnc = launch(
      execLine('x11vnc.service', 'ExecStart', runtimeDir, display).replace('-rfbport 5900', `-rfbport ${port}`),
    );
    const outcome = await new Promise<string>((resolve) => {
      x11vnc.on('exit', (code) => resolve(`exited ${code}`));
      setTimeout(() => resolve('still running'), 10_000);
    });

    expect(outcome).toMatch(/^exited [1-9]/);
    expect(await canConnect(port)).toBe(false);
  }, 30_000);
});
