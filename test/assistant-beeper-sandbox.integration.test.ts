import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BeeperFeed } from './beeper-feed.js';
import { unusedPort } from './ports.js';

/**
 * The sandbox of the assistant's own Beeper runtime, proven under real
 * systemd. deploy/systemd/assistant-beeper.service promises that the server
 * runs as a user of its own, sees nothing of the home directories or of the
 * owner's processes, keeps the account's data where only it can read it, and,
 * where systemd was built with BPF, may listen on its own port and on no
 * other (never the owner's Beeper Desktop's). The unit file reads the same
 * whether systemd keeps those promises or not, so only a probe from inside
 * can tell. This runs the real deploy/assistant-beeper.sh with the real sudo
 * and systemd, installing a stand-in server from a stand-in feed
 * (test/beeper-feed.ts); the stand-in answers, from inside the running unit,
 * what it can reach.
 *
 * It installs into /opt and /etc/systemd/system, so it runs only on GitHub's
 * runners, which give every run a fresh VM: never on a real host, even one
 * that sets CI. There, a missing prerequisite fails the suite instead of
 * skipping it.
 */

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'assistant-beeper.sh');
const UNIT = 'assistant-beeper.service';
const OWNER_BEEPER_PORT = 23373;
/** Where DynamicUser= keeps the unit's StateDirectory=; /var/lib/assistant-beeper links to it. */
const DATA = '/var/lib/private/assistant-beeper';

// GitHub's own runners give every run a fresh VM; a self-hosted runner that
// set GITHUB_ACTIONS could be a real machine, which this test would change.
const onRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
if (onRunner) {
  if (!existsSync('/run/systemd/system')) throw new Error('CI must run on a host booted with systemd');
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) throw new Error('CI must have passwordless sudo');
  for (const path of [`/etc/systemd/system/${UNIT}`, '/opt/beeper-server']) {
    if (existsSync(path)) throw new Error(`this host already has ${path}, which this test would replace and then remove`);
  }
}

/** Runs the script as a Claude session does: no terminal, nothing on stdin. */
const runDetached = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

const journal = () =>
  spawnSync('sudo', ['journalctl', '-u', UNIT, '--no-pager', '-n', '50'], { encoding: 'utf8' }).stdout;
const asRoot = (...args: string[]) => spawnSync('sudo', args, { encoding: 'utf8' });

describe.runIf(onRunner)('the assistant’s Beeper runtime sandbox (real systemd and sudo, CI only)', () => {
  const owner = userInfo();
  let feed: BeeperFeed | undefined;
  let feedUrl: string;
  let port: number;
  let config: string | undefined;
  // SocketBindAllow/Deny, which hold the server to its port, need a systemd
  // built with its BPF framework. CI runs one without (24.04) and one with
  // (26.04); the script warns on the first.
  let systemd = '';
  let portLockApplies = false;
  /** What the install printed. */
  let installed = '';
  // What the server must not see, though the owner can.
  const homeMarker = join(homedir(), `assistant-sandbox-marker-${process.pid}`);
  const tmpMarker = join(tmpdir(), `assistant-sandbox-marker-${process.pid}`);

  const install = async (args: string[] = []) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(BEEPER_|CLAUDE_MESSENGER_|ASSISTANT_)/.test(name)),
    );
    const result = await runDetached(args, {
      ...env,
      ASSISTANT_BEEPER_FEED: feedUrl,
      ASSISTANT_BEEPER_PORT: String(port),
      ASSISTANT_CONFIG_DIR: config!,
    });
    expect(result.code, `${result.stdout}\n${result.stderr}\n${journal()}`).toBe(0);
    return result;
  };

  /** Asks the running server to try something from inside its sandbox. */
  const inside = async (probe: 'stat' | 'create' | 'listen', query: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${port}/test/${probe}?${new URLSearchParams(query)}`);
    return (await response.json()) as { ok?: true; error?: string };
  };
  /** Every start of the server recorded in its data, as root reads it. */
  const starts = () => asRoot('cat', `${DATA}/starts.log`).stdout.split('\n').filter(Boolean);

  beforeAll(async () => {
    feed = new BeeperFeed();
    feed.latest = { version: '4.3.176' };
    feedUrl = await feed.start();
    port = await unusedPort();
    config = join(mkdtempSync(join(tmpdir(), 'assistant-config-')), 'assistant');
    for (const marker of [homeMarker, tmpMarker]) writeFileSync(marker, '');
    systemd = spawnSync('systemctl', ['--version'], { encoding: 'utf8' }).stdout;
    portLockApplies = /\+BPF_FRAMEWORK\b/.test(systemd);
    const result = await install();
    installed = result.stdout + result.stderr;
  }, 120_000);

  afterAll(async () => {
    asRoot('systemctl', 'disable', '--now', UNIT);
    asRoot('systemctl', 'clean', '--what=state', UNIT);
    asRoot('rm', '-f', `/etc/systemd/system/${UNIT}`);
    asRoot('rm', '-rf', '/opt/beeper-server');
    asRoot('systemctl', 'daemon-reload');
    await feed?.stop();
    for (const marker of [homeMarker, tmpMarker]) rmSync(marker, { force: true });
    if (config) rmSync(join(config, '..'), { recursive: true, force: true });
  });

  it('runs as a user of its own, neither root nor the owner, and starts at boot', async () => {
    const identity = (await (await fetch(`http://127.0.0.1:${port}/test/identity`)).json()) as { uid: number };
    expect(identity.uid).not.toBe(0);
    expect(identity.uid).not.toBe(owner.uid);
    // `static`, a unit with no [Install], would also exit 0.
    expect(spawnSync('systemctl', ['is-enabled', UNIT], { encoding: 'utf8' }).stdout.trim()).toBe('enabled');
  });

  it('keeps the account’s data where only it can read it', async () => {
    expect(await inside('create', { path: '/var/lib/assistant-beeper/probe' })).toEqual({ ok: true });
    // Not even the owner can look.
    expect(() => readdirSync('/var/lib/assistant-beeper')).toThrow(/EACCES/);
    expect(asRoot('stat', '-c', '%a', DATA).stdout.trim()).toBe('700');
    expect(asRoot('stat', '-c', '%a', `${DATA}/probe`).stdout.trim()).toBe('600');
  });

  it.each([
    ['the owner’s home', () => homeMarker],
    ['the owner’s /tmp', () => tmpMarker],
    ['the owner’s processes', () => `/proc/${process.pid}`],
  ])('sees nothing of %s', async (_, path) => {
    expect(existsSync(path()), `outside: ${path()}`).toBe(true);
    expect((await inside('stat', { path: path() })).error, `inside: ${path()}`).toMatch(/^(ENOENT|EACCES)$/);
  });

  it.each([
    ['the server it runs', '/opt/beeper-server/probe'],
    ['the system’s configuration', '/etc/assistant-beeper-probe'],
    ['other services’ data', '/var/lib/assistant-beeper-probe'],
  ])('cannot change %s', async (_, path) => {
    expect((await inside('create', { path })).error).toBe('EROFS');
  });

  it('may listen on its own port and, where systemd was built with BPF, on no other; elsewhere the install says so', async () => {
    const elsewhere = await unusedPort();
    // Free outside, so a refusal inside is the sandbox's.
    for (const free of [OWNER_BEEPER_PORT, elsewhere]) {
      await new Promise<void>((resolve, reject) => {
        const server = createServer().once('error', reject);
        server.listen(free, '127.0.0.1', () => server.close(() => resolve()));
      });
    }
    const version = systemd.split('\n')[0];

    const owners = await inside('listen', { port: String(OWNER_BEEPER_PORT) });
    const other = await inside('listen', { port: String(elsewhere) });

    if (portLockApplies) {
      expect(owners, `${version}, built with BPF, should refuse the owner's port`).toEqual({ error: 'EPERM' });
      expect(other, `${version}, built with BPF, should refuse any other port`).toEqual({ error: 'EPERM' });
      expect(installed).not.toContain('cannot hold Beeper Server to its own port');
    } else {
      // The gap the script warns of, pinned down so the warning stays true.
      expect(owners, `${version}, built without BPF, is expected not to hold the server to its port`).toEqual({ ok: true });
      expect(other).toEqual({ ok: true });
      expect(installed).toContain('cannot hold Beeper Server to its own port');
    }
    // Allowed, and taken: by the server itself.
    expect(await inside('listen', { port: String(port) })).toEqual({ error: 'EADDRINUSE' });
  });

  it('changes nothing on a second run under the real systemd', async () => {
    const before = starts();

    const again = await install();

    expect(again.stdout).toContain('Beeper Server 4.3.176 is the latest stable build, and running');
    expect(starts()).toEqual(before);
  });

  // Keep last: it deletes the data the tests above probe.
  it('--reset deletes the account’s data, and the server starts again on none', async () => {
    expect(await inside('create', { path: '/var/lib/assistant-beeper/signed-in' })).toEqual({ ok: true });
    expect((await install()).stdout).toContain("signed in to the assistant's account");

    const reset = await install(['--reset']);

    expect(reset.stdout).toContain('not signed in to an account yet');
    expect(asRoot('test', '-e', `${DATA}/signed-in`).status).not.toBe(0);
    expect(starts()).toHaveLength(1);
  });
});
