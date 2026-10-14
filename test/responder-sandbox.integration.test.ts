import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';
import { StandInAnthropic } from './stand-in-anthropic.js';

/**
 * The responder's sandbox, proven under real systemd, with the real Claude
 * Code answering inside it. deploy/systemd/claude-messenger-responder.service
 * promises the MCP service's walls (test/mcp-sandbox.integration.test.ts
 * proves those), widened only by what answering needs: the assistant's
 * configuration to read, its audit trail and state to write, and Claude
 * Code, signed in with a token and a configuration of the service's own. The
 * unit file reads the same whether systemd keeps those promises or not, so
 * this runs the real deploy/responder.sh with the real sudo and systemd, has
 * the service answer an @Claude between two mock Beepers (the owner's, and
 * the assistant's own) and a stand-in Anthropic API, and then probes the
 * sandbox from inside the running service, as its user. Last, it stops the
 * service as it runs and as it starts, which a PID namespace of its own makes
 * a test of what runs as PID 1 there.
 *
 * Claude Code is installed as its native installer installs it: the binary
 * in the home under versions/, and a link to it first on PATH. Its settings,
 * in the service's own configuration, point it at the stand-in; nothing else
 * is changed for the test. Node is in the home behind a shim, as nvm and asdf
 * install it, and CI turns on Ubuntu's restriction on unprivileged user
 * namespaces first, as for the MCP service.
 *
 * It installs a system unit, so it runs only on GitHub's runners, which give
 * every run a fresh VM: never on a real host, even one that sets CI. There, a
 * missing prerequisite fails the suite instead of skipping it.
 */

const REPO = join(import.meta.dirname, '..');
const UNIT = 'claude-messenger-responder.service';
const USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const OWNER = '@owner:beeper.local';
const CLAUDE = '@claude:beeper.local';
const DM = '!dm:beeper.local';
const FAMILY = '!family:beeper.local';
/** The service's own Claude Code token, as `deploy/responder.sh sign-in` saves it. */
const TOKEN = 'sk-ant-oat01-Sandbox_Test-Token-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNAA';
/** A word of the question, and one of the answer: either found on disk was written down. */
const ASKED = 'periwinkle';
const ANSWERED = 'lighthouse';

// GitHub's own runners give every run a fresh VM; a self-hosted runner that
// set GITHUB_ACTIONS could be a real machine, which this test would change.
const onRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const claudeCode = process.env.CLAUDE_CODE_UNDER_TEST;
if (onRunner) {
  if (!existsSync('/run/systemd/system')) throw new Error('CI must run on a host booted with systemd');
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) throw new Error('CI must have passwordless sudo');
  if (!existsSync(USERNS_RESTRICTION) || readFileSync(USERNS_RESTRICTION, 'utf8').trim() !== '1') {
    throw new Error(`CI must set ${USERNS_RESTRICTION} to 1, as Ubuntu 24.04+ does`);
  }
  if (!claudeCode) throw new Error('CI must install Claude Code and name it in CLAUDE_CODE_UNDER_TEST');
  if (existsSync(`/etc/systemd/system/${UNIT}`)) {
    throw new Error(`this host already has ${UNIT}, which this test would replace and then remove`);
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
  spawnSync('sudo', ['journalctl', '-u', UNIT, '--no-pager', '-n', '200'], { encoding: 'utf8' }).stdout;
const show = (property: string) =>
  execFileSync('systemctl', ['show', '--property', property, '--value', UNIT], { encoding: 'utf8' }).trim();

describe.runIf(onRunner)('the responder sandbox (real systemd and sudo, real Claude Code, CI only)', () => {
  const home = homedir();
  const { uid, gid, username } = userInfo();
  let install: string | undefined;
  let toolchain: string | undefined;
  /** Where Claude Code is installed, as its native installer installs it under a home. */
  let claudeHome: string | undefined;
  let assistantDir: string | undefined;
  const owner = new MockBeeperServer();
  const assistant = new MockBeeperServer();
  const api = new StandInAnthropic();
  let pid: number;
  /** What the install printed. */
  let installed = '';
  // PrivatePIDs, which gives the service its own PID namespace and so closes
  // the /proc escape below, needs systemd 257. CI runs both: 24.04 (255) and
  // 26.04 (259).
  let systemdMajor = 0;
  let privatePidsApplies = false;
  // What the service must not see, though its user can.
  const homeMarker = join(home, `cm-responder-marker-${process.pid}`);
  const hostTmpMarker = join(tmpdir(), `cm-responder-marker-${process.pid}`);

  const claudeBin = () => join(claudeHome!, '.local', 'bin');
  const claudeVersion = (version: string) => join(claudeHome!, '.local', 'share', 'claude', 'versions', version);
  /** Claude Code at `version`, installed and made current as its updater does: the link swapped in one rename. */
  const installClaudeCode = (version: string) => {
    mkdirSync(join(claudeHome!, '.local', 'share', 'claude', 'versions'), { recursive: true });
    mkdirSync(claudeBin(), { recursive: true });
    copyFileSync(realpathSync(claudeCode!), claudeVersion(version));
    chmodSync(claudeVersion(version), 0o755);
    symlinkSync(claudeVersion(version), join(claudeBin(), 'claude.next'));
    renameSync(join(claudeBin(), 'claude.next'), join(claudeBin(), 'claude'));
  };

  beforeAll(async () => {
    // Under $HOME, as on a real host. Not under /tmp: the service gets a private one.
    install = mkdtempSync(join(home, 'cm-responder-'));
    // Only responder.sh, outside the sandbox, reads deploy/; the service
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

    toolchain = mkdtempSync(join(home, 'cm-responder-node-'));
    mkdirSync(join(toolchain, 'installs'));
    mkdirSync(join(toolchain, 'shims'));
    copyFileSync(process.execPath, join(toolchain, 'installs', 'node'));
    chmodSync(join(toolchain, 'installs', 'node'), 0o755);
    writeFileSync(join(toolchain, 'shims', 'node'), `#!/bin/sh\nexec '${join(toolchain, 'installs', 'node')}' "$@"\n`, {
      mode: 0o755,
    });

    claudeHome = mkdtempSync(join(home, 'cm-responder-claude-'));
    installClaudeCode('1.0.0');

    const ownerUrl = await owner.start();
    owner.self = { id: OWNER, fullName: 'Owner' };
    owner.accounts = [
      { accountID: 'matrix', network: 'Beeper' },
      { accountID: 'whatsapp-1', network: 'WhatsApp' },
    ];
    owner.chats = [
      wireChat({
        id: DM,
        accountID: 'matrix',
        network: 'Beeper',
        title: 'Claude',
        participants: { items: [{ id: OWNER, isSelf: true }, { id: CLAUDE, fullName: 'Claude' }], hasMore: false, total: 2 },
      }),
      wireChat({ id: FAMILY, accountID: 'whatsapp-1', network: 'WhatsApp', type: 'group', title: 'Family' }),
    ];
    const assistantUrl = await assistant.start();
    assistant.self = { id: CLAUDE, fullName: 'Claude' };
    assistant.accounts = [{ accountID: 'matrix', network: 'Beeper' }];
    assistant.chats = [
      wireChat({
        id: DM,
        accountID: 'matrix',
        network: 'Beeper',
        title: 'Owner',
        participants: { items: [{ id: CLAUDE, isSelf: true }, { id: OWNER, fullName: 'Owner' }], hasMore: false, total: 2 },
      }),
    ];
    api.reply = `Dinner is at the ${ANSWERED}.`;
    const apiUrl = await api.start();

    // The owner's install, connected to their Beeper.
    writeFileSync(
      join(install, '.env'),
      `BEEPER_BASE_URL=${ownerUrl}\nBEEPER_ACCESS_TOKEN=${owner.token}\nBEEPER_POLL_INTERVAL_MS=1000\n`,
      { mode: 0o600 },
    );
    // The assistant's configuration, with a policy that lets it answer in its
    // chat with the owner, and Claude Code signed in for the service. Claude
    // Code's settings there send it to the stand-in.
    assistantDir = mkdtempSync(join(home, 'cm-responder-assistant-'));
    writeFileSync(join(assistantDir, '.env'), `BEEPER_BASE_URL=${assistantUrl}\nBEEPER_ACCESS_TOKEN=${assistant.token}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      join(assistantDir, 'policy.json'),
      JSON.stringify({ version: 1, capabilities: { read: true, send: true }, send: { chatAllowlist: [DM], maxMessagesPerHour: 30 } }),
    );
    writeFileSync(join(assistantDir, 'claude-code.env'), `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    mkdirSync(join(assistantDir, 'state', 'claude-code'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(assistantDir, 'state', 'claude-code', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: apiUrl, NO_PROXY: '127.0.0.1' } }),
    );

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(BEEPER_|CLAUDE_MESSENGER_|ASSISTANT_|RESPONDER_)/.test(name)),
    );
    const run = await runDetached(join(install, 'deploy', 'responder.sh'), {
      ...env,
      PATH: `${join(toolchain, 'shims')}:${claudeBin()}:${process.env.PATH}`,
      ASSISTANT_CONFIG_DIR: assistantDir,
      RESPONDER_TIME_ZONE: 'America/Los_Angeles',
    });
    installed = run.stdout + run.stderr;
    expect(run.code, `${installed}\n${journal()}`).toBe(0);

    pid = Number(show('MainPID'));
    systemdMajor = Number(/systemd (\d+)/.exec(execFileSync('systemctl', ['--version'], { encoding: 'utf8' }))?.[1]);
    privatePidsApplies = systemdMajor >= 257;
    for (const marker of [homeMarker, hostTmpMarker]) writeFileSync(marker, '');
  }, 300_000);

  afterAll(async () => {
    spawnSync('sudo', ['systemctl', 'disable', '--now', UNIT]);
    spawnSync('sudo', ['rm', '-f', `/etc/systemd/system/${UNIT}`]);
    spawnSync('sudo', ['systemctl', 'daemon-reload']);
    await Promise.all([owner.stop(), assistant.stop(), api.stop()]);
    for (const marker of [homeMarker, hostTmpMarker]) rmSync(marker, { force: true });
    for (const dir of [install, toolchain, claudeHome, assistantDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Runs a shell snippet in the service's mount namespace, as its user. */
  const inside = (script: string, ...args: string[]) =>
    spawnSync(
      'sudo',
      ['nsenter', '-t', String(pid), '-m', '-S', String(uid), '-G', String(gid), '--', 'sh', '-c', script, 'sh', ...args],
      { encoding: 'utf8' },
    );
  const outside = (script: string, ...args: string[]) => spawnSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' });
  /** A process's state (R, S, Z for a zombie...) and parent, or nothing once it is gone. */
  const stat = (id: number) => {
    try {
      const line = readFileSync(`/proc/${id}/stat`, 'utf8');
      const [state, parent] = line.slice(line.lastIndexOf(')') + 2).split(' ');
      return { state: state!, parent: Number(parent) };
    } catch {
      return undefined;
    }
  };
  /** The processes `parent` started, or took on when theirs ended. */
  const children = (parent: number) =>
    readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .filter((id) => stat(id)?.parent === parent);
  const exe = (id: number) => {
    try {
      return readlinkSync(`/proc/${id}/exe`);
    } catch {
      return undefined;
    }
  };
  const nodeBinary = () => join(toolchain!, 'installs', 'node');
  /** The responder: the node that the unit's main process, a shell, runs. */
  const responder = (main = pid) => children(main).find((child) => exe(child) === nodeBinary());
  const touch = 'touch "$1" && rm -f "$1"';
  const exists = 'test -e "$1"';
  const expectReadOnlyInside = (probe: string) => {
    const attempt = inside(touch, probe);
    expect(attempt.status, `inside: ${probe}`).not.toBe(0);
    expect(attempt.stderr, `inside: ${probe}`).toContain('Read-only file system');
  };
  /** The four directories it may write: the install's and the assistant's audit trails and state. */
  const writable = () => [
    join(install!, 'audit'),
    join(install!, 'state'),
    join(assistantDir!, 'audit'),
    join(assistantDir!, 'state'),
  ];

  it('runs as the install owner, under the system manager, and starts at boot', () => {
    expect(pid).toBeGreaterThan(0);
    expect(show('User')).toBe(username);
    // `static`, a unit with no [Install], would also exit 0.
    expect(spawnSync('systemctl', ['is-enabled', UNIT], { encoding: 'utf8' }).stdout.trim()).toBe('enabled');
  });

  it('runs the node in the home that the shim on PATH leads to, as the child of a shell', () => {
    expect(exe(pid)).toBe(realpathSync('/bin/sh'));
    expect(responder(), `the shell's children: ${children(pid).map((child) => exe(child)).join(', ')}`).toBeDefined();
  });

  it('answers @Claude from inside the sandbox, through Claude Code signed in with the service’s own token', async () => {
    owner.messages.push(
      wireMessage({
        id: 'ask-1',
        chatID: FAMILY,
        accountID: 'whatsapp-1',
        isSender: true,
        senderID: OWNER,
        text: `@Claude where is dinner, the ${ASKED} place or the other one?`,
        timestamp: new Date().toISOString(),
      }),
    );
    const sent = () =>
      assistant.requests
        .filter((r) => r.method === 'POST' && r.path === `/v1/chats/${DM}/messages`)
        .map((r) => (r.body as { text: string }).text);
    for (const end = Date.now() + 90_000; sent().length === 0; await sleep(250)) {
      if (Date.now() > end) throw new Error(`no answer was sent:\n${journal()}`);
    }

    expect(sent()).toEqual([expect.stringMatching(new RegExp(`^In "Family", .*\\n\\nDinner is at the ${ANSWERED}\\.$`))]);
    // Claude Code asked about what was written, signed in as the service, and
    // never otherwise: the stand-in is reached only through the settings in
    // the service's own Claude Code configuration.
    expect(JSON.stringify(api.messageRequests())).toContain(ASKED);
    const signedIn = api.requests.filter((r) => r.url.startsWith('/v1/messages')).map((r) => r.authorization);
    expect(new Set(signedIn)).toEqual(new Set([`Bearer ${TOKEN}`]));
  }, 120_000);

  it('writes down nothing of what it was asked or answered: not in its journal, its audit trails, its state or its /tmp', () => {
    // After the answer above, which took both words through the service.
    expect(api.messageRequests().length).toBeGreaterThan(0);
    const leaks = (text: string) => [ASKED, ANSWERED].filter((word) => text.includes(word));

    expect(leaks(journal())).toEqual([]);
    for (const dir of writable()) {
      for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const file = join(entry.parentPath, entry.name);
        expect(leaks(readFileSync(file, 'utf8')), file).toEqual([]);
      }
    }
    const grep = inside('! grep -rqs -e "$1" -e "$2" /tmp', ASKED, ANSWERED);
    expect(grep.status, `inside /tmp: ${grep.stdout}${grep.stderr}`).toBe(0);
  });

  it('can write its two audit trails and two state directories', () => {
    for (const dir of writable()) {
      const attempt = inside(touch, join(dir, 'sandbox-probe'));
      expect(attempt.status, `${dir}: ${attempt.stderr}`).toBe(0);
    }
  });

  it('sees nothing of the home directories or /run/user but what it was given', () => {
    expect(outside(exists, homeMarker).status, `outside: ${homeMarker}`).toBe(0);
    expect(inside(exists, homeMarker).status, `inside: ${homeMarker}`).not.toBe(0);
    const runUser = inside('ls -A /run/user');
    expect(runUser.status, runUser.stderr).toBe(0);
    expect(runUser.stdout, 'inside: /run/user').toBe('');
    for (const given of [join(install!, '.env'), join(assistantDir!, '.env'), join(assistantDir!, 'policy.json')]) {
      expect(inside(exists, given).status, given).toBe(0);
    }
    // Claude Code only where PATH has it: not the rest of its installation.
    expect(inside(exists, join(claudeBin(), 'claude')).status).toBe(0);
    expect(outside(exists, claudeVersion('1.0.0')).status).toBe(0);
    expect(inside(exists, claudeVersion('1.0.0')).status).not.toBe(0);
  });

  // Each is somewhere the service's user can write outside the sandbox, so
  // the sandbox is what stops the service; a row per probe names exactly
  // which path leaked when one fails.
  it.each([
    ['its own home', () => join(home, 'sandbox-probe')],
    ['the install it runs from', () => join(install!, 'sandbox-probe')],
    ['the assistant’s configuration, policy and tokens', () => join(assistantDir!, 'sandbox-probe')],
    ['the Claude Code it runs', () => join(claudeBin(), 'sandbox-probe')],
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
    expect(readlinkSync(`/proc/${pid}/ns/ipc`)).not.toBe(readlinkSync('/proc/self/ns/ipc'));
  });

  it('cannot reach the owner’s other processes through /proc when it has its own PID namespace, and the install says when it has not', () => {
    // The test runner is another process of the same user, outside the
    // sandbox, and /proc/<its pid>/root leads back to the real home: the way
    // around the mount sandbox to the owner's SSH keys and Claude sign-in.
    // PrivatePIDs (systemd 257+) closes it; on 255/256 it stays open, and
    // responder.sh warns as it installs.
    const escape = `/proc/${process.pid}/root${homeMarker}`;
    const reachable = inside(exists, escape).status === 0;
    const servicePidNs = readlinkSync(`/proc/${pid}/ns/pid`);
    const ourPidNs = readlinkSync('/proc/self/ns/pid');
    const warning = `systemd ${systemdMajor} is older than 257, so the responder cannot get its own process namespace`;
    if (privatePidsApplies) {
      expect(servicePidNs, `systemd ${systemdMajor} should give the service its own PID namespace`).not.toBe(ourPidNs);
      expect(reachable, `the /proc escape should be closed on systemd ${systemdMajor}`).toBe(false);
      expect(installed).not.toContain('older than 257');
    } else {
      expect(servicePidNs, `systemd ${systemdMajor} has no PrivatePIDs, so the PID namespace is the host's`).toBe(ourPidNs);
      expect(reachable, `the /proc escape is expected still open on systemd ${systemdMajor}`).toBe(true);
      expect(installed).toContain(warning);
    }
  });

  it('gets a /tmp of its own', () => {
    expect(outside(exists, hostTmpMarker).status).toBe(0);
    expect(inside(exists, hostTmpMarker).status).not.toBe(0);
  });

  it('runs the Claude Code current as it starts, so an update reaches it when it next restarts', async () => {
    const running = () => Number(inside('stat -c %i "$1"', join(claudeBin(), 'claude')).stdout.trim());
    expect(running()).toBe(statSync(claudeVersion('1.0.0')).ino);

    installClaudeCode('1.0.1');
    // The service keeps the version it started with,
    expect(running()).toBe(statSync(claudeVersion('1.0.0')).ino);

    const restart = spawnSync('sudo', ['systemctl', 'restart', UNIT], { encoding: 'utf8' });
    expect(restart.status, restart.stderr).toBe(0);
    // Started again once node runs: systemd has set the sandbox up by then.
    const restarted = () => {
      const now = Number(show('MainPID'));
      try {
        return now !== pid && responder(now) ? now : 0;
      } catch {
        return 0;
      }
    };
    for (const end = Date.now() + 30_000; restarted() === 0; await sleep(100)) {
      if (Date.now() > end) throw new Error(`the responder did not start again:\n${journal()}`);
    }
    pid = restarted();
    // and runs the new one from its restart on.
    expect(running()).toBe(statSync(claudeVersion('1.0.1')).ino);
  }, 60_000);

  it('reaps what is left running in it, as a Claude Code run that was stopped can leave a process', async () => {
    // A process whose parent ends goes to PID 1 of its PID namespace, which
    // must reap it when it ends too, or it stays a zombie until the service
    // restarts. Without a namespace of its own (systemd < 257), the host takes it.
    const left = spawnSync(
      'sudo',
      ['nsenter', '-t', String(pid), '-m', '-p', '-S', String(uid), '-G', String(gid), '--', 'sh', '-c', 'sleep 1 >/dev/null 2>&1 &'],
      { encoding: 'utf8' },
    );
    expect(left.status, left.stderr).toBe(0);
    const comm = (id: number) => readFileSync(`/proc/${id}/comm`, 'utf8').trim();
    expect(children(pid).filter((child) => comm(child) === 'sleep')).toHaveLength(privatePidsApplies ? 1 : 0);

    await sleep(2000);
    expect(children(pid).filter((child) => stat(child)?.state === 'Z')).toEqual([]);
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

  it('stops promptly on systemctl stop, letting the responder finish as it does on SIGTERM', () => {
    const started = Date.now();
    // One that ignored SIGTERM would hang here until TimeoutStopSec (90s) and
    // then be SIGKILLed; the 30s cap turns that hang into a failure.
    stopped(started, spawnSync('sudo', ['systemctl', 'stop', UNIT], { encoding: 'utf8', timeout: 30_000 }));
    // It finished as it does on SIGTERM, not killed by it: it said so after
    // systemd began the stop.
    const lines = journal().split('\n');
    const stopping = lines.reduce((last, line, i) => (line.includes(`Stopping ${UNIT}`) ? i : last), -1);
    expect(stopping, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(lines.slice(stopping).filter((line) => /: Stopped\.$/.test(line)), lines.join('\n')).toHaveLength(1);
  });

  it('stops at once when stopped as it starts, before it can handle a stop', async () => {
    // The assistant's Beeper, the first it asks as it starts, never answers,
    // so it waits there, before it handles a stop: the moment a stop came,
    // in CI, just after a restart. Node in its place as PID 1 would drop it.
    assistant.stalls = () => true;
    try {
      const asked = assistant.requests.length;
      const start = spawnSync('sudo', ['systemctl', 'start', UNIT], { encoding: 'utf8' });
      expect(start.status, start.stderr).toBe(0);
      for (const end = Date.now() + 30_000; assistant.requests.length === asked; await sleep(100)) {
        if (Date.now() > end) throw new Error(`the responder never asked its Beeper anything:\n${journal()}`);
      }
      const started = Date.now();
      stopped(started, spawnSync('sudo', ['systemctl', 'stop', UNIT], { encoding: 'utf8', timeout: 30_000 }));
    } finally {
      assistant.stalls = undefined;
    }
  }, 60_000);
});
