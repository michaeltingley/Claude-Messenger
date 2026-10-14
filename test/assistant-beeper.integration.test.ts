import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeeperFeed, type FeedEntry } from './beeper-feed.js';
import { FakeHost, type ScriptResult } from './fake-host.js';
import { unusedPort } from './ports.js';

/**
 * deploy/assistant-beeper.sh installs the runtime for the assistant's own
 * Beeper account: Beeper Server, from Beeper's stable update feed, as the
 * system unit assistant-beeper.service. It runs here as a real subprocess,
 * the way a Claude session runs it (no terminal, nothing on stdin), on a
 * fake host (test/fake-host.ts) whose systemd really starts what it installs.
 *
 * The feed and the server are stand-ins (test/beeper-feed.ts): the real
 * build is 275 MB, and signs in to Beeper. The unit's sandbox under the real
 * systemd is proven in test/assistant-beeper-sandbox.integration.test.ts;
 * the real server under it, only on a host.
 */

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'assistant-beeper.sh');
const UNIT = 'assistant-beeper.service';
/** As the script names this machine's architecture, from `uname -m`. */
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const OTHER_ARCH = ARCH === 'x64' ? 'arm64' : 'x64';

// A run that starts the server waits a second or more for it to answer, and some tests run several.
describe('deploy/assistant-beeper.sh (subprocess, no terminal, fake host)', { timeout: 60_000 }, () => {
  let host: FakeHost;
  let feed: BeeperFeed;
  let feedUrl: string;
  let port: number;

  beforeEach(async () => {
    host = new FakeHost();
    feed = new BeeperFeed();
    feed.latest = { version: '4.3.176' };
    feedUrl = await feed.start();
    port = await unusedPort();
  });

  afterEach(async () => {
    host.dispose();
    await feed.stop();
  });

  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    host.runDetached('bash', [SCRIPT, ...args], {
      ASSISTANT_BEEPER_FEED: feedUrl,
      ASSISTANT_BEEPER_PORT: String(port),
      ...extra,
    });

  const url = () => `http://127.0.0.1:${port}`;
  const configDir = () => join(host.home, '.config', 'claude-messenger', 'assistant');
  const envFile = () => join(configDir(), '.env');
  /** The unit's StateDirectory=, which the fake systemd keeps under the fake root. */
  const stateDir = () => join(host.sysroot, 'var', 'lib', 'assistant-beeper');
  const installedServer = () => join(host.sysroot, 'opt', 'beeper-server', 'beeper-server');
  const installedUnit = () => join(host.systemUnitDir, UNIT);
  /** A failing run's message: what it printed, and what the units it started printed. */
  const why = (result: ScriptResult) => `${result.stdout}\n${result.stderr}\n${host.logs()}`;

  /** The version of Beeper Server answering on the assistant's port. */
  const serving = async (): Promise<string> => {
    const info = (await (await fetch(`${url()}/v1/info`)).json()) as { app: { version: string } };
    return info.app.version;
  };
  /** Each start of the server since its data was last deleted, oldest first. */
  const starts = (): Array<{ argv: string[]; version: string }> => {
    const log = join(stateDir(), 'starts.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; version: string });
  };
  /** Kills the server as a crash would, leaving systemd's record of it, and waits until it is gone. */
  const killServer = async () => {
    const pid = Number(host.read(`system/pids/${UNIT}`));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    host.stopUnits();
    for (const end = Date.now() + 10_000; alive(); await sleep(25)) {
      if (Date.now() > end) throw new Error(`the server (pid ${pid}) outlived SIGTERM`);
    }
  };
  /** What a sign-up leaves in the server's data, as far as the stand-in can tell. */
  const signIn = () => writeFileSync(join(stateDir(), 'signed-in'), '');
  /** Commands run as root since `from` calls into the log. */
  const rootCalls = (from = 0) => host.calls().slice(from).filter((call) => call.startsWith('sudo '));
  /** Nothing of the runtime anywhere: no server, no unit, nothing done as root but asking for sudo. */
  const expectNothingInstalled = () => {
    expect(existsSync(installedServer()), 'the server').toBe(false);
    expect(existsSync(installedUnit()), 'the unit').toBe(false);
    expect(rootCalls().filter((call) => call !== 'sudo -n true')).toEqual([]);
  };

  describe('a fresh install', () => {
    it('installs the stable server from the feed and starts it at boot, signed out, on the assistant’s port', async () => {
      const result = await run();

      expect(result.code, why(result)).toBe(0);
      // Asked the feed for exactly the stable Server build for this machine, and got it.
      expect(feed.queries.map((query) => Object.fromEntries(query))).toEqual([
        { bundleID: 'com.automattic.beeper.server', platform: 'linux', channel: 'stable', arch: ARCH },
      ]);
      expect(feed.downloads).toEqual([`beeper-server-4.3.176-linux-${ARCH}.tar.gz`]);
      expect(statSync(installedServer()).mode & 0o777).toBe(0o755);
      // Started by systemd from the unit: loopback only, its own port, its own data.
      expect(await serving()).toBe('4.3.176');
      expect(starts()).toEqual([
        expect.objectContaining({
          version: '4.3.176',
          argv: ['--host=127.0.0.1', `--port=${port}`, `--data-dir=${stateDir()}`],
        }),
      ]);
      expect(host.has(`system/enabled/${UNIT}`)).toBe(true);
      expect(readFileSync(installedUnit(), 'utf8')).not.toContain('__PORT__');
      expect(result.stdout).toContain(`${UNIT}: Beeper Server 4.3.176 on ${url()}`);
      expect(result.stdout).toContain('not signed in to an account yet');
    });

    it('makes the assistant’s configuration, owner-only, pointing at its own runtime', async () => {
      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(statSync(configDir()).mode & 0o777).toBe(0o700);
      expect(statSync(envFile()).mode & 0o777).toBe(0o600);
      expect(readFileSync(envFile(), 'utf8')).toBe(`BEEPER_BASE_URL=${url()}\n`);
    });

    it('keeps a configuration already there, closing it to everyone but the owner', async () => {
      const saved = `BEEPER_BASE_URL=${url()}\nBEEPER_ACCESS_TOKEN=assistant-token\n`;
      mkdirSync(configDir(), { recursive: true, mode: 0o755 });
      writeFileSync(envFile(), saved, { mode: 0o644 });

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(readFileSync(envFile(), 'utf8')).toBe(saved);
      expect(statSync(envFile()).mode & 0o777).toBe(0o600);
      expect(statSync(configDir()).mode & 0o777).toBe(0o700);
    });

    it('warns that the server is not held to its port on a host whose systemd lacks BPF, and installs anyway', async () => {
      host.set('systemd-without-bpf');

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      // Named, with the port it could take, so the gap does not pass unnoticed.
      expect(result.stdout).toContain('cannot hold Beeper Server to its own port');
      expect(result.stdout).toContain("23373 too while the owner's Beeper Desktop is not running");
      // Everything else still happened: the unit is installed, enabled and serving.
      expect(host.has(`system/enabled/${UNIT}`)).toBe(true);
      expect(await serving()).toBe('4.3.176');
    });

    it('says nothing of the port where systemd can hold the server to it', async () => {
      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('BPF');
      expect(result.stdout + result.stderr).not.toContain('cannot hold');
    });
  });

  describe('a run on an installed runtime', () => {
    it('changes nothing when the latest stable build already runs: no download, no restart, no root writes', async () => {
      expect((await run()).code).toBe(0);
      const from = host.calls().length;

      const again = await run();

      expect(again.code, why(again)).toBe(0);
      expect(again.stdout).toContain('Beeper Server 4.3.176 is the latest stable build, and running');
      expect(feed.downloads).toHaveLength(1);
      expect(starts()).toHaveLength(1);
      expect(rootCalls(from).filter((call) => /^sudo (install|tee|systemctl (restart|daemon-reload))\b/.test(call))).toEqual(
        [],
      );
    });

    it('updates to a newer stable build, restarting onto it with the account kept', async () => {
      // 4.3.100 sorts before 4.3.99 as text; as versions, it is the newer.
      feed.latest = { version: '4.3.99' };
      expect((await run()).code).toBe(0);
      signIn();
      feed.latest = { version: '4.3.100' };

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain('Beeper Server 4.3.100 installed');
      expect(await serving()).toBe('4.3.100');
      expect(starts().map((start) => start.version)).toEqual(['4.3.99', '4.3.100']);
      expect(result.stdout).toContain("signed in to the assistant's account");
    });

    it('keeps a running build newer than the feed’s, whose data an older build may not read', async () => {
      feed.latest = { version: '4.3.100' };
      expect((await run()).code).toBe(0);
      feed.latest = { version: '4.3.99' };

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain("Beeper Server 4.3.100 runs, newer than the stable feed's 4.3.99; kept.");
      expect(feed.downloads).toEqual([`beeper-server-4.3.100-linux-${ARCH}.tar.gz`]);
      expect(await serving()).toBe('4.3.100');
      expect(starts()).toHaveLength(1);
    });

    it('starts an installed server that is down, without downloading it again', async () => {
      expect((await run()).code).toBe(0);
      await killServer();

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(await serving()).toBe('4.3.176');
      expect(feed.downloads).toHaveLength(1);
      expect(starts()).toHaveLength(2);
    });

    it('replaces an installed build that no longer starts with the feed’s', async () => {
      feed.latest = { version: '4.3.176', crashes: true };
      expect((await run()).code).toBe(1);
      feed.latest = { version: '4.3.176' };

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(await serving()).toBe('4.3.176');
      expect(feed.downloads).toHaveLength(2);
    });
  });

  describe('what the feed may announce', () => {
    const swapFile = (entry: FeedEntry, file: string) => entry.url.replace(/[^/]+$/, file);

    it.each<[string, (entry: FeedEntry) => unknown, string]>([
      [
        'a nightly build',
        (e) => ({ ...e, url: swapFile(e, `beeper-server-nightly-${e.version}-linux-${ARCH}.tar.gz`) }),
        `its download is beeper-server-nightly-4.3.176-linux-${ARCH}.tar.gz, not the stable build beeper-server-4.3.176-linux-${ARCH}.tar.gz`,
      ],
      [
        'a Beeper Desktop build',
        (e) => ({ ...e, url: swapFile(e, `Beeper-${e.version}-x86_64.AppImage`) }),
        `its download is Beeper-4.3.176-x86_64.AppImage, not the stable build`,
      ],
      [
        'a build for another architecture',
        (e) => ({ ...e, url: swapFile(e, `beeper-server-${e.version}-linux-${OTHER_ARCH}.tar.gz`) }),
        `its download is beeper-server-4.3.176-linux-${OTHER_ARCH}.tar.gz, not the stable build`,
      ],
      ['no version', (e) => ({ ...e, version: undefined }), 'it names no version'],
      ['a version that is not one', (e) => ({ ...e, version: '4.3.176 $(id)' }), 'it names no version'],
      ['no download', (e) => ({ ...e, url: undefined }), 'it gives no download URL'],
      ['a download from the filesystem', (e) => ({ ...e, url: e.url.replace(/^http:/, 'file:') }), 'it gives no download URL'],
      ['no SHA-512', (e) => ({ ...e, sha512: undefined }), 'it gives no SHA-512'],
      ['a SHA-512 that is not one', (e) => ({ ...e, sha512: 'abc==' }), 'it gives no SHA-512'],
      ['something that is not JSON', () => '<html>Service Unavailable</html>', 'it is not JSON'],
    ])('refuses %s, installing nothing', async (_, shape, reason) => {
      feed.shapeFeed = shape;

      const result = await run();

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(`Beeper's update feed was refused: ${reason}`);
      expect(feed.downloads).toEqual([]);
      expectNothingInstalled();
    });

    it('stops when the feed does not answer, installing nothing', async () => {
      feed.latest = undefined;

      const result = await run();

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(`Beeper's update feed did not answer: ${feedUrl}?bundleID=`);
      expectNothingInstalled();
    });

    it('refuses a download that does not match the feed’s SHA-512, installing nothing', async () => {
      feed.shapeFeed = (e) => ({ ...e, sha512: createHash('sha512').update('another build').digest('base64') });

      const result = await run();

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(
        "the download of Beeper Server 4.3.176 does not match the SHA-512 in Beeper's feed; nothing was installed.",
      );
      expect(feed.downloads).toHaveLength(1);
      expectNothingInstalled();
    });

    it.each(['no server', 'a symlink'] as const)(
      'refuses a download with %s where the server belongs, installing nothing',
      async (holds) => {
        feed.latest = { version: '4.3.176', holds };

        const result = await run();

        expect(result.code, why(result)).toBe(1);
        expect(result.stderr).toContain(
          `the Beeper Server 4.3.176 download has no beeper-server-4.3.176-linux-${ARCH}/beeper-server; nothing was installed.`,
        );
        expectNothingInstalled();
      },
    );

    it('fails, pointing at the journal, when the build it installs does not start', async () => {
      feed.latest = { version: '4.3.176', crashes: true };
      const started = Date.now();

      const result = await run();

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(
        `Beeper Server 4.3.176 is not answering on ${url()}. Check: sudo journalctl -u ${UNIT}`,
      );
      // It saw the server die, rather than waiting out its minute.
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  });

  describe('--reset', () => {
    it('deletes the account’s data and starts the same build again, signed out', async () => {
      expect((await run()).code).toBe(0);
      signIn();

      const result = await run(['--reset']);

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain('deleted; it starts again below, signed out');
      expect(result.stdout).toContain('not signed in to an account yet');
      expect(existsSync(join(stateDir(), 'signed-in'))).toBe(false);
      // A fresh data dir, one start in it, and no download.
      expect(starts()).toEqual([expect.objectContaining({ version: '4.3.176' })]);
      expect(feed.downloads).toHaveLength(1);
      expect(await serving()).toBe('4.3.176');
    });

    it('refuses while the account’s token is saved, which would outlive its keys, deleting nothing', async () => {
      expect((await run()).code).toBe(0);
      signIn();
      writeFileSync(envFile(), `BEEPER_BASE_URL=${url()}\nBEEPER_ACCESS_TOKEN=assistant-token\n`);
      const from = host.calls().length;

      const result = await run(['--reset']);

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(
        `the assistant's account is signed in here (its token is in ${envFile()}). A reset would delete its keys and leave that token working; nothing was deleted.`,
      );
      expect(existsSync(join(stateDir(), 'signed-in'))).toBe(true);
      expect(rootCalls(from).filter((call) => call !== 'sudo -n true')).toEqual([]);
      expect(await serving()).toBe('4.3.176');
    });

    it('installs it on a host where it never was', async () => {
      const result = await run(['--reset']);

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain('nothing to delete: it was never installed');
      expect(await serving()).toBe('4.3.176');
    });
  });

  describe('what it refuses before changing anything', () => {
    it('refuses the owner’s Beeper Desktop port', async () => {
      const result = await run([], { ASSISTANT_BEEPER_PORT: '23373' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "port 23373 is where the owner's Beeper Desktop answers; the assistant's runtime needs one of its own.",
      );
      expect(existsSync(configDir())).toBe(false);
      expectNothingInstalled();
    });

    it.each(['not-a-port', '80', '65536'])('refuses the port %s', async (bad) => {
      const result = await run([], { ASSISTANT_BEEPER_PORT: bad });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ASSISTANT_BEEPER_PORT must be');
      expect(existsSync(configDir())).toBe(false);
      expectNothingInstalled();
    });

    it.each<[string, string, string]>([
      ['another Beeper', 'BEEPER_BASE_URL=http://localhost:23373\n', 'http://localhost:23373'],
      [
        'the default Beeper',
        'BEEPER_ACCESS_TOKEN=assistant-token\n',
        "the owner's Beeper Desktop (the default, with no BEEPER_BASE_URL)",
      ],
    ])('refuses a configuration that points the assistant at %s, leaving it as it was', async (_, saved, named) => {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(envFile(), saved);

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `${envFile()} points the assistant at ${named}, not its own runtime at ${url()}. Set BEEPER_BASE_URL=${url()} there`,
      );
      expect(readFileSync(envFile(), 'utf8')).toBe(saved);
      expectNothingInstalled();
    });

    it('refuses to run as root', async () => {
      host.set('root');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Run as the user who owns this install, not root.');
      expect(existsSync(configDir())).toBe(false);
      expectNothingInstalled();
    });

    it('says it needs sudo, instead of hanging, when nobody can type sudo’s password', async () => {
      host.set('sudo-needs-password');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('this needs sudo, which it could not get');
      expect(existsSync(installedServer())).toBe(false);
      expect(existsSync(installedUnit())).toBe(false);
    });

    it('rejects an unknown argument with its usage', async () => {
      const result = await run(['--force']);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('usage: assistant-beeper.sh [--reset]');
      expect(existsSync(configDir())).toBe(false);
    });
  });
});
