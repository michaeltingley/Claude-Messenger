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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat } from './mock-beeper.js';
import { unusedPort } from './ports.js';

/**
 * The MCP service's sandbox, proven under real systemd. Its unit promises
 * that a compromised server sees nothing of the home directories but its
 * install, and can change only its audit trail and rate window. Run as a
 * user unit on Ubuntu 24.04+, it breaks that promise without a word (see
 * deploy/systemd/claude-messenger-mcp.service), and the unit file reads the
 * same either way, so only a probe can tell. This runs the real
 * deploy/configure.sh with the real sudo and systemd, then tries reads and
 * writes from inside the running service's mount namespace, as the
 * service's own user.
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

const onRunner = process.env.GITHUB_ACTIONS === 'true';
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
    const journal = () => spawnSync('sudo', ['journalctl', '-u', UNIT, '--no-pager', '-n', '50'], { encoding: 'utf8' }).stdout;
    expect(run.code, `${run.stdout}\n${run.stderr}\n${journal()}`).toBe(0);

    pid = Number(execFileSync('systemctl', ['show', '--property', 'MainPID', '--value', UNIT], { encoding: 'utf8' }));
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
  const touch = 'touch "$1" && rm -f "$1"';
  const exists = 'test -e "$1"';
  const expectReadOnlyInside = (probe: string) => {
    const attempt = inside(touch, probe);
    expect(attempt.status, `inside: ${probe}`).not.toBe(0);
    expect(attempt.stderr, `inside: ${probe}`).toContain('Read-only file system');
  };

  it('runs as the install owner, under the system manager, and starts at boot', () => {
    expect(pid).toBeGreaterThan(0);
    const show = (property: string) =>
      execFileSync('systemctl', ['show', '--property', property, '--value', UNIT], { encoding: 'utf8' }).trim();
    expect(show('User')).toBe(username);
    // `static`, a unit with no [Install], would also exit 0.
    expect(spawnSync('systemctl', ['is-enabled', UNIT], { encoding: 'utf8' }).stdout.trim()).toBe('enabled');
  });

  it('runs the node binary in the home that the shim on PATH leads to', () => {
    expect(readlinkSync(`/proc/${pid}/exe`)).toBe(join(toolchain!, 'installs', 'node'));
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

  it('cannot write to the home, the install, the system, or the host shared memory and message queues', () => {
    const probes = [
      join(home, 'sandbox-probe'),
      join(install!, 'sandbox-probe'),
      '/run/lock/sandbox-probe',
      '/dev/shm/sandbox-probe',
      '/dev/mqueue/sandbox-probe',
    ];
    for (const probe of probes) {
      // The user can write there outside the service, so the sandbox is what stops it.
      expect(outside(touch, probe).status, `outside: ${probe}`).toBe(0);
      expectReadOnlyInside(probe);
    }
  });

  it('cannot write to the empty stand-ins for the home directories and /run/user either', () => {
    for (const probe of ['/home/sandbox-probe', '/root/sandbox-probe', '/run/user/sandbox-probe']) {
      expectReadOnlyInside(probe);
    }
  });

  it('gets a /tmp of its own', () => {
    expect(outside(exists, hostTmpMarker).status).toBe(0);
    expect(inside(exists, hostTmpMarker).status).not.toBe(0);
  });
});
