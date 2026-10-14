import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat } from './mock-beeper.js';
import { unusedPort } from './ports.js';
import { childrenOf, executableOf } from './processes.js';

/**
 * The MCP service's sandbox, proven under real systemd. Its unit promises
 * that a compromised server sees nothing of the home directories but its
 * install, and can change only its audit trail and rate window. Run as a
 * user unit on Ubuntu 24.04+, it breaks that promise without a word (see
 * deploy/systemd/claude-messenger-mcp.service), and the unit file reads the
 * same either way, so only a probe can tell. This runs the real
 * deploy/configure.sh with the real sudo and systemd, then tries reads and
 * writes from inside the running service's mount namespace, as the
 * service's own user. Last, it stops the service as it runs and as it starts,
 * which a PID namespace of its own makes a test of what runs as PID 1 there.
 *
 * CI turns on Ubuntu's AppArmor restriction on unprivileged user namespaces
 * first, so the sandbox is proven on terms like a real host's. And node is
 * installed the way nvm and asdf install it: the binary in the home, first on
 * PATH as a shim that needs the rest of the toolchain, which the sandbox hides.
 *
 * It replaces the host's MCP service and its Claude Code registration, so it
 * runs only on GitHub's runners, which give every run a fresh VM: never on a
 * real host, even one that sets CI. There, a missing prerequisite fails the
 * suite instead of skipping it.
 */

const REPO = join(import.meta.dirname, '..');
const UNIT = 'claude-messenger-mcp.service';
const USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

// GitHub's own runners give every run a fresh VM; a self-hosted runner that
// set GITHUB_ACTIONS could be a real machine, which this test would wreck.
const onRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
if (onRunner) {
  if (!existsSync('/run/systemd/system')) throw new Error('CI must run on a host booted with systemd');
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) throw new Error('CI must have passwordless sudo');
  if (!existsSync(USERNS_RESTRICTION) || readFileSync(USERNS_RESTRICTION, 'utf8').trim() !== '1') {
    throw new Error(`CI must set ${USERNS_RESTRICTION} to 1, as Ubuntu 24.04+ does`);
  }
  if (existsSync(`/etc/systemd/system/${UNIT}`)) {
    throw new Error(`this host already has ${UNIT}, which this test would replace and then remove`);
  }
  if (spawnSync('sh', ['-c', 'command -v claude']).status === 0) {
    throw new Error('this host has Claude Code, whose claude-messenger server configure.sh would point at a throwaway install');
  }
}

/** Runs a script as a Claude session does: no terminal, nothing on stdin. */
const runDetached = (script: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

const journal = () =>
  spawnSync('sudo', ['journalctl', '-u', UNIT, '--no-pager', '-n', '50'], { encoding: 'utf8' }).stdout;
const show = (property: string) =>
  execFileSync('systemctl', ['show', '--property', property, '--value', UNIT], { encoding: 'utf8' }).trim();

describe.runIf(onRunner)('the MCP service sandbox (real systemd and sudo, CI only)', () => {
  const home = homedir();
  const { uid, gid, username } = userInfo();
  const runtimeDir = `/run/user/${uid}`;
  let homeMode: number | undefined;
  let madeRuntimeDir = false;
  let install: string | undefined;
  let toolchain: string | undefined;
  let mock: MockBeeperServer | undefined;
  let mcpPort: number;
  let pid: number;
  // PrivatePIDs, which gives the service its own PID namespace and so closes
  // the /proc escape below, needs systemd 257. CI runs both: 24.04 (255) and
  // 26.04 (259).
  let systemdMajor = 0;
  let privatePidsApplies = false;
  // What the service must not see, though its user can.
  const homeMarker = join(home, `cm-sandbox-marker-${process.pid}`);
  const runtimeMarker = join(runtimeDir, `cm-sandbox-marker-${process.pid}`);
  const hostTmpMarker = join(tmpdir(), `cm-sandbox-marker-${process.pid}`);

  beforeAll(async () => {
    homeMode = statSync(home).mode & 0o777;
    // Under $HOME, as on a real host. Not under /tmp: the service gets a private one.
    install = mkdtempSync(join(home, 'cm-sandbox-'));
    mkdirSync(join(install, '.git'));
    // Only configure.sh, outside the sandbox, reads deploy/; the service
    // reads the rest, and this checkout under $HOME is hidden from it.
    symlinkSync(join(REPO, 'deploy'), join(install, 'deploy'));
    execFileSync(join(REPO, 'node_modules', '.bin', 'tsc'), [
      '-p',
      join(REPO, 'tsconfig.json'),
      '--outDir',
      join(install, 'dist'),
      '--declaration',
      'false',
      '--sourceMap',
      'false',
    ]);
    copyFileSync(join(REPO, 'package.json'), join(install, 'package.json'));
    cpSync(join(REPO, 'node_modules'), join(install, 'node_modules'), { recursive: true, verbatimSymlinks: true });

    toolchain = mkdtempSync(join(home, 'cm-sandbox-node-'));
    mkdirSync(join(toolchain, 'installs'));
    mkdirSync(join(toolchain, 'shims'));
    copyFileSync(process.execPath, join(toolchain, 'installs', 'node'));
    chmodSync(join(toolchain, 'installs', 'node'), 0o755);
    writeFileSync(join(toolchain, 'shims', 'node'), `#!/bin/sh\nexec '${join(toolchain, 'installs', 'node')}' "$@"\n`, {
      mode: 0o755,
    });

    if (!existsSync(runtimeDir)) {
      execFileSync('sudo', ['install', '-d', '-m', '700', '-o', String(uid), '-g', String(gid), runtimeDir]);
      madeRuntimeDir = true;
    }

    mock = new MockBeeperServer();
    mock.chats = [wireChat()];
    const beeperUrl = await mock.start();
    mcpPort = await unusedPort();

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(BEEPER_|CLAUDE_MESSENGER_)/.test(name)),
    );
    const run = await runDetached(join(install, 'deploy', 'configure.sh'), {
      ...env,
      PATH: `${join(toolchain, 'shims')}:${process.env.PATH}`,
      BEEPER_BASE_URL: beeperUrl,
      CLAUDE_MESSENGER_MCP_PORT: String(mcpPort),
      // No Tailscale on the runner; publishing just warns.
      CLAUDE_MESSENGER_SERVE_TIMEOUT: '1',
    });
    expect(run.code, `${run.stdout}\n${run.stderr}\n${journal()}`).toBe(0);

    pid = Number(show('MainPID'));
    systemdMajor = Number(/systemd (\d+)/.exec(execFileSync('systemctl', ['--version'], { encoding: 'utf8' }))?.[1]);
    privatePidsApplies = systemdMajor >= 257;
    for (const marker of [homeMarker, runtimeMarker, hostTmpMarker]) writeFileSync(marker, '');
  }, 180_000);

  afterAll(async () => {
    spawnSync('sudo', ['systemctl', 'disable', '--now', UNIT]);
    spawnSync('sudo', ['rm', '-f', `/etc/systemd/system/${UNIT}`]);
    spawnSync('sudo', ['systemctl', 'daemon-reload']);
    await mock?.stop();
    for (const marker of [homeMarker, runtimeMarker, hostTmpMarker]) rmSync(marker, { force: true });
    if (madeRuntimeDir) spawnSync('sudo', ['rm', '-rf', runtimeDir]);
    if (install) rmSync(install, { recursive: true, force: true });
    if (toolchain) rmSync(toolchain, { recursive: true, force: true });
    if (homeMode !== undefined) chmodSync(home, homeMode);
  });

  /** Runs a shell snippet in the service's mount namespace, as its user. */
  const inside = (script: string, ...args: string[]) =>
    spawnSync(
      'sudo',
      ['nsenter', '-t', String(pid), '-m', '-S', String(uid), '-G', String(gid), '--', 'sh', '-c', script, 'sh', ...args],
      { encoding: 'utf8' },
    );
  const outside = (script: string, ...args: string[]) => spawnSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' });
  const nodeBinary = () => join(toolchain!, 'installs', 'node');
  /** The server: the node that the unit's main process, a shell, runs. */
  const server = (main = pid) => childrenOf(main).find((child) => executableOf(child) === nodeBinary());
  const touch = 'touch "$1" && rm -f "$1"';
  const exists = 'test -e "$1"';
  const expectReadOnlyInside = (probe: string) => {
    const attempt = inside(touch, probe);
    expect(attempt.status, `inside: ${probe}`).not.toBe(0);
    expect(attempt.stderr, `inside: ${probe}`).toContain('Read-only file system');
  };

  it('runs as the install owner, under the system manager, and starts at boot', () => {
    expect(pid).toBeGreaterThan(0);
    expect(show('User')).toBe(username);
    // `static`, a unit with no [Install], would also exit 0.
    expect(spawnSync('systemctl', ['is-enabled', UNIT], { encoding: 'utf8' }).stdout.trim()).toBe('enabled');
  });

  it('runs the node in the home that the shim on PATH leads to, as the child of a shell', () => {
    expect(executableOf(pid)).toBe(realpathSync('/bin/sh'));
    expect(server(), `the shell's children: ${childrenOf(pid).map(executableOf).join(', ')}`).toBeDefined();
  });

  it('serves MCP from inside the sandbox, auditing to where it may write', async () => {
    const auditDir = join(install!, 'audit');
    const audited = () => readdirSync(auditDir).map((f) => readFileSync(join(auditDir, f), 'utf8')).join('');
    const token = /^CLAUDE_MESSENGER_MCP_TOKEN=(.*)$/m.exec(readFileSync(join(install!, '.env'), 'utf8'))?.[1];
    const before = audited().length;

    const client = new Client({ name: 'sandbox-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect((result.content as Array<{ text: string }>).map((c) => c.text).join('\n')).toContain('whatsapp-1');
    } finally {
      await client.close();
    }
    expect(audited().length).toBeGreaterThan(before);
  });

  it('can write its audit trail and rate window', () => {
    for (const dir of ['audit', 'state']) {
      const attempt = inside(touch, join(install!, dir, 'sandbox-probe'));
      expect(attempt.status, attempt.stderr).toBe(0);
    }
  });

  it('sees nothing of the home directories or /run/user but its install', () => {
    for (const marker of [homeMarker, runtimeMarker]) {
      expect(outside(exists, marker).status, `outside: ${marker}`).toBe(0);
      expect(inside(exists, marker).status, `inside: ${marker}`).not.toBe(0);
    }
    expect(inside(exists, join(install!, '.env')).status).toBe(0);
  });

  // Each is somewhere the service's user can write outside the sandbox, so
  // the sandbox is what stops the service; a row per probe names exactly
  // which path leaked when one fails.
  it.each([
    ['its own home', () => join(home, 'sandbox-probe')],
    ['the install it runs from', () => join(install!, 'sandbox-probe')],
    ['the system (/run/lock)', () => '/run/lock/sandbox-probe'],
    ['the host shared memory (/dev/shm)', () => '/dev/shm/sandbox-probe'],
    ['the host message queues (/dev/mqueue)', () => '/dev/mqueue/sandbox-probe'],
  ])('cannot write to %s', (_, probe) => {
    const path = probe();
    expect(outside(touch, path).status, `outside: ${path}`).toBe(0);
    expectReadOnlyInside(path);
  });

  it.each(['/home/sandbox-probe', '/root/sandbox-probe', '/run/user/sandbox-probe'])(
    'cannot write to the empty stand-in %s',
    (probe) => expectReadOnlyInside(probe),
  );

  it('runs in its own IPC namespace, not the host’s', () => {
    // PrivateIPC, from systemd 248, so on every host CI runs this on.
    expect(readlinkSync(`/proc/${pid}/ns/ipc`)).not.toBe(readlinkSync('/proc/self/ns/ipc'));
  });

  it('cannot reach the owner’s other processes through /proc when it has its own PID namespace', () => {
    // The test runner is another process of the same user, outside the
    // sandbox, and /proc/<its pid>/root leads back to the real home — the
    // trick a compromised server would use to read SSH keys or Beeper's token
    // around the mount sandbox. PrivatePIDs (systemd 257+) puts the service in
    // its own PID namespace, where that pid is invisible and the path does not
    // resolve. On 255/256 it still resolves; configure.sh warns at install
    // time, and this pins down which way the host actually went.
    const escape = `/proc/${process.pid}/root${homeMarker}`;
    const reachable = inside(exists, escape).status === 0;
    const servicePidNs = readlinkSync(`/proc/${pid}/ns/pid`);
    const ourPidNs = readlinkSync('/proc/self/ns/pid');
    if (privatePidsApplies) {
      expect(servicePidNs, `systemd ${systemdMajor} should give the service its own PID namespace`).not.toBe(ourPidNs);
      expect(reachable, `the /proc escape should be closed on systemd ${systemdMajor}`).toBe(false);
    } else {
      expect(servicePidNs, `systemd ${systemdMajor} has no PrivatePIDs, so the PID namespace is the host's`).toBe(ourPidNs);
      expect(reachable, `the /proc escape is expected still open on systemd ${systemdMajor}`).toBe(true);
    }
  });

  it('exposes the node binary the unit names, but not the rest of the toolchain the shim needs', () => {
    // BindReadOnlyPaths names the real binary (installs/node); the shim and
    // the rest of the toolchain are under the home the sandbox hides.
    expect(inside(exists, join(toolchain!, 'installs', 'node')).status, 'the bound node binary').toBe(0);
    expect(inside(exists, join(toolchain!, 'shims', 'node')).status, 'the shim under the hidden home').not.toBe(0);
  });

  it('gets a /tmp of its own', () => {
    expect(outside(exists, hostTmpMarker).status).toBe(0);
    expect(inside(exists, hostTmpMarker).status).not.toBe(0);
  });

  // Keep these last: they stop the service, so any test after them would find it down.
  const stopped = (started: number, stop: { error?: Error; status: number | null; stderr: string }) => {
    expect(stop.error, `systemctl stop did not return: ${stop.error?.message}`).toBeUndefined();
    expect(stop.status, stop.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    // A clean stop leaves it inactive; a SIGKILL after a SIGTERM nothing
    // handled would leave it failed. (Restart= does not fire for a stop.)
    expect(show('ActiveState')).toBe('inactive');
  };

  it('stops promptly on systemctl stop, letting the server close as it does on SIGTERM', () => {
    const started = Date.now();
    // One that ignored SIGTERM would hang here until TimeoutStopSec (90s) and
    // then be SIGKILLed; the 30s cap turns that hang into a failure.
    stopped(started, spawnSync('sudo', ['systemctl', 'stop', UNIT], { encoding: 'utf8', timeout: 30_000 }));
    // It closed as it does on SIGTERM, not ended by it: it exited 0, where one
    // the stop ended would have exited 143.
    expect(show('ExecMainStatus')).toBe('0');
  }, 60_000);

  it('stops at once when stopped as it starts, before it can handle a stop', async () => {
    // Its policy, which it reads as it starts, before it handles a stop, is a
    // pipe nothing writes to, so it waits there: where a stop that comes just
    // after a start finds it. Node in its place as PID 1 would drop that stop.
    const policy = join(install!, 'policy.json');
    renameSync(policy, `${policy}.kept`);
    execFileSync('mkfifo', [policy]);
    try {
      const start = spawnSync('sudo', ['systemctl', 'start', UNIT], { encoding: 'utf8' });
      expect(start.status, start.stderr).toBe(0);
      // Stopped once node runs: a stop any sooner would come before there was
      // a node to stop.
      for (const end = Date.now() + 30_000; server(Number(show('MainPID'))) === undefined; await sleep(100)) {
        if (Date.now() > end) throw new Error(`the server never started:\n${journal()}`);
      }
      const started = Date.now();
      stopped(started, spawnSync('sudo', ['systemctl', 'stop', UNIT], { encoding: 'utf8', timeout: 30_000 }));
      // The stop ended it, before it could handle one: 143, which its unit
      // counts a clean stop.
      expect(show('ExecMainStatus')).toBe('143');
    } finally {
      rmSync(policy, { force: true });
      renameSync(`${policy}.kept`, policy);
    }
  }, 60_000);
});
