import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unusedPort } from './ports.js';

/**
 * On a shared host (docs/SHARED-HOST.md), loopback and the X socket are
 * reachable by every local user. These tests start the real Xvfb and x11vnc
 * exactly as deploy/systemd/ runs them, then speak the real X11 and RFB
 * handshakes to prove that neither one admits a client without its secret.
 * A config check alone would not prove that. They stop them as systemd stops
 * the units, too.
 *
 * The binaries are installed in CI. Locally, the suite skips when they're
 * missing, but in CI a missing binary fails it instead of passing vacuously.
 */

const SYSTEMD = join(import.meta.dirname, '..', 'deploy', 'systemd');
const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const toolsPresent = ['Xvfb', 'xauth', 'mcookie', 'x11vnc'].every(has);
if (!toolsPresent && process.env.CI) throw new Error('CI must install xvfb, xauth and x11vnc for these tests');

/**
 * The value of a unit's KEY= setting, read as systemd reads it: whitespace
 * around the key, the "=" and the value doesn't count. A key set twice is
 * refused, since this test doesn't model which one wins.
 */
function setting(unit: string, key: string): string | undefined {
  const assignment = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`);
  const values = readFileSync(join(SYSTEMD, unit), 'utf8')
    .split('\n')
    .flatMap((l) => assignment.exec(l)?.[1] ?? []);
  if (values.length > 1) throw new Error(`${unit} sets ${key}= more than once, which this test does not model`);
  return values[0];
}

/** A unit's Exec*= command line, with systemd's specifiers expanded the way a real host would. */
function execLine(unit: string, key: 'ExecStartPre' | 'ExecStart', runtimeDir: string, display: number): string {
  const line = setting(unit, key);
  if (line === undefined) throw new Error(`${unit} has no ${key}=`);
  return line.replaceAll('%t', runtimeDir).replaceAll('$$', '$').replaceAll(':99', `:${display}`);
}

/** Settings that change how systemd stops a unit, which `stop` does not model. */
const UNMODELED_STOP_SETTINGS = [
  'Type',
  'PIDFile',
  'ExecStop',
  'ExecStopPost',
  'KillMode',
  'RestartKillSignal',
  'FinalKillSignal',
  'SendSIGHUP',
  'SendSIGKILL',
  'SuccessExitStatus',
  'TimeoutSec',
  'TimeoutStopSec',
];

/** The signal systemd stops a unit with: its KillSignal=, else SIGTERM. */
function killSignal(unit: string): NodeJS.Signals {
  const unmodeled = UNMODELED_STOP_SETTINGS.filter((key) => setting(unit, key) !== undefined);
  if (unmodeled.length > 0) throw new Error(`${unit} sets ${unmodeled.join(', ')}, which this test does not model`);
  const signal = setting(unit, 'KillSignal') ?? 'SIGTERM';
  if (!(signal in constants.signals)) throw new Error(`${unit}: KillSignal=${signal} is a form this test does not read`);
  return signal as NodeJS.Signals;
}

/** A unit's main process, started as systemd starts it, and the signal systemd stops it with. */
interface Service {
  readonly unit: string;
  readonly process: ChildProcess;
  readonly killSignal: NodeJS.Signals;
}

/** How long a stop waits after the unit's KillSignal before it kills the process, as systemd does after TimeoutStopSec. */
const STOP_GRACE_MS = 3_000;

/**
 * How a stop ended, as systemd judges it: "clean" if the process exited 0 or
 * died of SIGHUP, SIGINT, SIGTERM or SIGPIPE; "failed" if it ended any other
 * way, which leaves the unit failed; "timed out" if it was still running
 * after the grace period and had to be killed. "Not running" is a process
 * that had exited before the stop, which proves nothing about how it stops.
 */
type StopOutcome = 'clean' | 'failed' | 'timed out' | 'not running';

const CLEAN_SIGNALS = new Set<NodeJS.Signals>(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGPIPE']);

/**
 * Stops a unit's process as systemd stops the unit: with its KillSignal, then
 * SIGKILL if it is still running after a grace period.
 */
async function stop(service: Service): Promise<StopOutcome> {
  const child = service.process;
  if (child.exitCode !== null || child.signalCode !== null) return 'not running';
  const judge = (code: number | null, signal: NodeJS.Signals | null): StopOutcome =>
    code === 0 || (signal !== null && CLEAN_SIGNALS.has(signal)) ? 'clean' : 'failed';
  const exited = new Promise<StopOutcome>((resolve) => child.once('exit', (code, signal) => resolve(judge(code, signal))));
  child.kill(service.killSignal);
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited,
    new Promise<StopOutcome>((resolve) => (timer = setTimeout(() => resolve('timed out'), STOP_GRACE_MS))),
  ]);
  clearTimeout(timer);
  if (outcome === 'timed out') {
    child.kill('SIGKILL');
    await exited;
  }
  return outcome;
}

function freeDisplay(): number {
  for (let n = 150 + Math.floor(Math.random() * 50); n < 250; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('no free X display');
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
    socket.setTimeout(5_000, () => socket.destroy(new Error('no RFB handshake within 5 s')));
    socket.on('close', () => reject(new Error('closed before offering security types')));
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

/** The security types a viewer is offered once x11vnc listens on `port`, or none if it never does within 15 s. */
async function offeredOnceListening(port: number): Promise<number[]> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 250))) {
    const offered = await rfbSecurityTypes(port).catch((): number[] => []);
    if (offered.length > 0) return offered;
  }
  return [];
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
  const services: Service[] = [];

  /**
   * Starts a unit's ExecStart on this test's display, with x11vnc on `port`.
   * A unit stopped in a way `stop` doesn't model is refused before it runs.
   */
  const start = (unit: string, port?: number): Service => {
    const signal = killSignal(unit);
    let commandLine = execLine(unit, 'ExecStart', runtimeDir, display);
    if (port !== undefined) commandLine = commandLine.replace('-rfbport 5900', `-rfbport ${port}`);
    const child = spawn('sh', ['-c', `exec ${commandLine}`], { stdio: 'ignore' });
    const service = { unit, process: child, killSignal: signal };
    services.push(service);
    return service;
  };

  beforeEach(async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'runtime-'));
    display = freeDisplay();
    const pre = spawnSync('sh', ['-c', execLine('xvfb.service', 'ExecStartPre', runtimeDir, display)], {
      encoding: 'utf8',
    });
    expect(pre.status, pre.stderr).toBe(0);
    start('xvfb.service');
    expect(await until(() => existsSync(`/tmp/.X11-unix/X${display}`), 10_000)).toBe(true);
  });

  afterEach(async () => {
    // Whatever still runs is stopped as systemd would stop it, last started
    // first: x11vnc before the display it shows. Each must stop cleanly; a
    // stop that hangs or fails is how the hang in x11vnc's SIGTERM showed up.
    const stops: string[] = [];
    for (const service of services.splice(0).reverse()) {
      const { exitCode, signalCode } = service.process;
      if (exitCode === null && signalCode === null) stops.push(`${service.unit}: ${await stop(service)}`);
    }
    rmSync(runtimeDir, { recursive: true, force: true });

    expect(stops.filter((outcome) => !outcome.endsWith(': clean'))).toEqual([]);
  }, 20_000);

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
    const port = await unusedPort();
    start('x11vnc.service', port);

    expect(await offeredOnceListening(port)).toEqual([2]);
  }, 30_000);

  it('the VNC hop stops cleanly on its stop signal, even just after a viewer leaves, as at `signin-surface.sh down`', async () => {
    // Stopping x11vnc.service stops noVNC first, which drops any viewer, so
    // x11vnc can get its stop signal while it is still restoring the display
    // after them. With SIGTERM this fails in the first round, on its exit
    // status 2 or on a hang; the ten rounds give the stop signal ten chances
    // at that race. The signal goes out before anything is checked, as
    // systemd sends it as soon as noVNC has stopped.
    writeFileSync(join(runtimeDir, 'claude-messenger', 'vncpasswd'), 'Pw7xQ2kz\n', { mode: 0o600 });
    for (let round = 1; round <= 10; round++) {
      const port = await unusedPort();
      const x11vnc = start('x11vnc.service', port);
      const offered = await offeredOnceListening(port);
      const outcome = await stop(x11vnc);

      expect(offered).toEqual([2]);
      expect(outcome, `round ${round}`).toBe('clean');
    }
  }, 60_000);

  it('without a password file, the VNC hop does not start at all', async () => {
    const port = await unusedPort();
    const x11vnc = start('x11vnc.service', port);
    const outcome = await new Promise<string>((resolve) => {
      x11vnc.process.on('exit', (code) => resolve(`exited ${code}`));
      setTimeout(() => resolve('still running'), 10_000);
    });

    expect(outcome).toMatch(/^exited [1-9]/);
    expect(await canConnect(port)).toBe(false);
  }, 30_000);
});
