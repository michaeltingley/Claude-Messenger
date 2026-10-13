import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost, type DetachedRun, type ScriptResult } from './fake-host.js';
import { MockBeeperServer, wireChat } from './mock-beeper.js';

const REPO = join(import.meta.dirname, '..');

/**
 * The install path a Claude session drives: deploy/bootstrap.sh, which ends
 * in deploy/configure.sh. Both run here as real subprocesses, the way a
 * session runs them: no terminal, nothing on stdin. The host is fake
 * (test/fake-host.ts), but its systemd really starts the built MCP service,
 * and Beeper is the mock, which also plays the person: signing in and
 * answering the approval box.
 *
 * A real host still has to prove what can't run here: downloading and
 * starting Beeper Desktop itself, and the real systemd and Tailscale.
 */

/** The CLI built once, as `npm run build` builds it on a host. */
let build: string;

beforeAll(() => {
  build = mkdtempSync(join(tmpdir(), 'claude-messenger-build-'));
  execFileSync(join(REPO, 'node_modules', '.bin', 'tsc'), [
    '-p',
    join(REPO, 'tsconfig.json'),
    '--outDir',
    join(build, 'dist'),
    '--declaration',
    'false',
    '--sourceMap',
    'false',
  ]);
  // Node resolves the CLI's module type and dependencies from where it really lives.
  copyFileSync(join(REPO, 'package.json'), join(build, 'package.json'));
  symlinkSync(join(REPO, 'node_modules'), join(build, 'node_modules'));
}, 120_000);

afterAll(() => {
  rmSync(build, { recursive: true, force: true });
});

/**
 * A port nothing listens on, below Linux's ephemeral range (32768 and up), so
 * that no other test's listen(0) or outgoing connection takes it before the
 * MCP service binds it.
 */
const unusedPort = async (): Promise<number> => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
        .once('error', () => resolve(false))
        .listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
};

/** Each of `markers` appears in `text`, in this order. */
const expectInOrder = (text: string, ...markers: string[]) => {
  let from = 0;
  for (const marker of markers) {
    const at = text.indexOf(marker, from);
    expect(at, `"${marker}" after offset ${from} in:\n${text}`).toBeGreaterThanOrEqual(0);
    from = at + marker.length;
  }
};

describe('the session-run install (subprocess, no terminal, fake host)', () => {
  let host: FakeHost;
  let mock: MockBeeperServer;
  let beeperUrl: string;
  let install: string;
  let mcpPort: number;

  beforeEach(async () => {
    host = FakeHost.provisioned();
    mock = new MockBeeperServer();
    mock.chats = [wireChat()];
    beeperUrl = await mock.start();
    // A checkout, as bootstrap leaves it: the repo's deploy/ and a built dist/.
    install = join(host.root, 'claude-messenger');
    mkdirSync(join(install, '.git'), { recursive: true });
    symlinkSync(join(REPO, 'deploy'), join(install, 'deploy'));
    symlinkSync(join(build, 'dist'), join(install, 'dist'));
    mcpPort = await unusedPort();
  });

  afterEach(async () => {
    host.dispose();
    await mock.stop();
  });

  const settings = (extra: Record<string, string> = {}) => ({
    BEEPER_BASE_URL: beeperUrl,
    CLAUDE_MESSENGER_HOME: install,
    CLAUDE_MESSENGER_MCP_PORT: String(mcpPort),
    ...extra,
  });
  const configureScript = () => join(install, 'deploy', 'configure.sh');
  const configure = (args: string[] = [], extra: Record<string, string> = {}) =>
    host.runDetached('bash', [configureScript(), ...args], settings(extra));

  /** A failing run's message: what it printed, and what the units it started printed. */
  const why = (run: ScriptResult) => `${run.stdout}\n${run.stderr}\n${host.logs()}`;

  /** Resolves once `ready()` holds. Fails at once if `run` ends first, with what it printed. */
  const until = async (ready: () => boolean, what: string, run?: DetachedRun) => {
    for (const end = Date.now() + 30_000; !ready(); await sleep(25)) {
      if (run && !run.running()) throw new Error(`ended before ${what}:\n${run.output()}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  };

  /**
   * `run`'s result, or a failure with what it printed if it is not done
   * within `ms`. Done means its output has closed, which also waits for
   * anything it started that still runs.
   */
  const doneWithin = async (run: DetachedRun, ms: number): Promise<ScriptResult> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const exited = run.child.exitCode ?? run.child.signalCode ?? 'no';
        reject(new Error(`not done after ${ms} ms (it exited: ${exited}):\n${run.output()}\n${host.logs()}`));
      }, ms);
    });
    try {
      return await Promise.race([run.done, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Beeper Desktop installed by bootstrap: headless, its window only on the sign-in surface. */
  const managedBeeper = () => {
    mkdirSync(host.unitDir, { recursive: true });
    writeFileSync(join(host.unitDir, 'beeper-desktop.service'), '[Service]\n');
  };

  const envText = () => readFileSync(join(install, '.env'), 'utf8');
  const envValue = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(envText())?.[1];
  /** Everything the installed service has audited so far. */
  const audited = () => {
    const dir = join(install, 'audit');
    return readdirSync(dir)
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('');
  };

  const listAccounts = async (transport: Transport): Promise<string> => {
    const client = new Client({ name: 'install-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      return (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    } finally {
      await client.close();
    }
  };

  /** Ask the installed MCP service, as a client elsewhere on the tailnet would. */
  const listAccountsOverHttp = () =>
    listAccounts(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${envValue('CLAUDE_MESSENGER_MCP_TOKEN')}` } },
      }),
    );

  /** What configure registered with Claude Code on this host: scope, name, and the command a session starts. */
  const registration = () => {
    const args = host.read('claude-mcp').split('\n').filter(Boolean);
    const options = args.slice(0, args.indexOf('--'));
    return {
      scope: options[options.indexOf('--scope') + 1],
      name: options.at(-1),
      command: args.slice(args.indexOf('--') + 1),
    };
  };

  /** Start the registered server as a Claude Code session does, from anywhere, with nothing else in its environment. */
  const listAccountsOverStdio = async ([command, ...args]: string[]) => {
    const transport = new StdioClientTransport({
      command: command!,
      args,
      cwd: host.root,
      env: { HOME: host.home, PATH: '/usr/bin:/bin' },
      stderr: 'pipe',
    });
    let said = '';
    transport.stderr?.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')));
    try {
      return await listAccounts(transport);
    } catch (err) {
      throw new Error(`${(err as Error).message}; the server said:\n${said}`, { cause: err });
    }
  };

  /** Neither credential may appear in anything the install prints. */
  const expectNoSecrets = (run: ScriptResult) => {
    for (const secret of [envValue('BEEPER_ACCESS_TOKEN'), envValue('CLAUDE_MESSENGER_MCP_TOKEN')]) {
      if (secret) expect(run.stdout + run.stderr).not.toContain(secret);
    }
  };

  describe('deploy/configure.sh', () => {
    it('opens the Beeper screen for the approval, saves the token, closes the screen, and serves MCP with it', async () => {
      managedBeeper();

      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      // The person gets the screen, then what to do on it, and it closes once they have approved.
      expectInOrder(
        run.stdout,
        'vnc.html#autoconnect=1&password=',
        "Beeper's own window",
        '✓ Approved',
        'sign-in surface closed',
      );
      expect(host.surfaceClosed()).toBe(true);
      // Closed before anything else runs, not only on the way out.
      expectInOrder(
        host.calls().join('\n'),
        'tailscale serve --https 8443 off',
        'systemctl --user restart claude-messenger-mcp.service',
      );

      const token = envValue('BEEPER_ACCESS_TOKEN');
      expect(token).toBeDefined();
      expect(mock.issuedTokens.get(token!)).toEqual({ scope: 'read', revoked: false });
      expect(envValue('CLAUDE_MESSENGER_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(install, '.env')).mode & 0o777).toBe(0o600);
      // Nobody else on the host may read the home that holds it (docs/SHARED-HOST.md, rule 1).
      expect(statSync(host.home).mode & 0o077).toBe(0);
      expect(existsSync(join(install, 'policy.json'))).toBe(true);
      expectNoSecrets(run);

      // The service systemd started uses the token connect saved, end to end,
      // and audits to where its unit lets it write.
      const before = audited().length;
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
      expect(audited().length).toBeGreaterThan(before);
      expect(host.read('serve-443').trim()).toBe(String(mcpPort));
      expect(run.stdout).toContain('URL:    https://box.example-tailnet.ts.net/mcp');

      // Claude Code sessions on the host get a server of their own, over
      // stdio, with no secret on its command line for other users to read.
      const registered = registration();
      expect(registered).toMatchObject({ scope: 'user', name: 'claude-messenger' });
      for (const secret of [token!, envValue('CLAUDE_MESSENGER_MCP_TOKEN')!]) {
        expect(registered.command.join(' ')).not.toContain(secret);
      }
      expect(await listAccountsOverStdio(registered.command)).toContain('whatsapp-1');
    }, 90_000);

    it('closes the Beeper screen and starts nothing when the approval is declined', async () => {
      managedBeeper();
      mock.decide = () => ({ approve: false });

      const run = await configure();

      expect(run.code, why(run)).toBe(1);
      expect(run.stderr).toContain('[access_denied]');
      expect(run.stderr).toContain('run configure.sh again');
      expect(host.surfaceClosed()).toBe(true);
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBeUndefined();
      // Holding the MCP token, it was owner-only from the moment it existed.
      expect(statSync(join(install, '.env')).mode & 0o777).toBe(0o600);
      expect(existsSync(join(host.unitDir, 'claude-messenger-mcp.service'))).toBe(false);
      expect(readdirSync(join(host.state, 'pids'))).toEqual([]);
    }, 90_000);

    it('closes the screen and gives up at once when only the script is stopped mid-wait', async () => {
      managedBeeper();
      mock.decide = () => 'no-answer';
      const run = host.startDetached('bash', [configureScript()], settings());
      await until(() => mock.openBoxes === 1, 'the approval box to open', run);

      // The script alone, as `kill <pid>` does: connect is its child, not a target.
      process.kill(run.child.pid!, 'SIGTERM');
      const result = await doneWithin(run, 10_000);

      expect(result.code, why(result)).toBe(130);
      expect(host.surfaceClosed()).toBe(true);
      await until(() => mock.openBoxes === 0, 'connect to stop waiting on the box');
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBeUndefined();
    }, 90_000);

    it('finishes closing the screen when signals arrive while it is closing', async () => {
      managedBeeper();
      host.set('slow-serve-off');
      const closes = () => host.calls().filter((c) => c === 'tailscale serve --https 8443 off').length;
      const run = host.startDetached('bash', [configureScript()], settings());

      // The whole process group, as Ctrl-C in a terminal or a runner's timeout signals it.
      await until(() => closes() === 1, 'the close after approval', run);
      process.kill(-run.child.pid!, 'SIGTERM');
      await until(() => closes() === 2, 'the close on the way out', run);
      process.kill(-run.child.pid!, 'SIGTERM');
      const result = await doneWithin(run, 10_000);

      expect(result.code, why(result)).toBe(130);
      expect(host.surfaceClosed()).toBe(true);
    }, 90_000);

    it('closes a sign-in screen left open even when it stops early', async () => {
      managedBeeper();
      host.exposeSurface();
      // A checkout nobody built yet.
      rmSync(join(install, 'dist'));

      const run = await configure();

      expect(run.code, why(run)).toBe(1);
      expect(run.stderr).toContain('not built');
      expect(host.surfaceClosed()).toBe(true);
    }, 90_000);

    it('closes a sign-in screen left open, on a run that has nothing to approve', async () => {
      managedBeeper();
      expect((await configure()).code).toBe(0);
      // Left open by a manual `up`, or by a run killed with -9.
      host.exposeSurface();
      const earlier = host.calls().length;

      const rerun = await configure();

      expect(rerun.code, why(rerun)).toBe(0);
      expect(mock.approvalRequests).toHaveLength(1);
      expect(host.surfaceClosed()).toBe(true);
      expectInOrder(
        host.calls().slice(earlier).join('\n'),
        'tailscale serve --https 8443 off',
        'systemctl --user restart claude-messenger-mcp.service',
      );
    }, 120_000);

    it('starts nothing while a sign-in screen left open cannot be closed', async () => {
      managedBeeper();
      expect((await configure()).code).toBe(0);
      host.exposeSurface().set('fail-serve-off');
      const earlier = host.calls().length;

      const rerun = await configure();

      expect(rerun.code, why(rerun)).toBe(1);
      expect(rerun.stderr).toContain('the Beeper sign-in surface is still exposed');
      expect(host.calls().slice(earlier).filter((c) => c.includes('claude-messenger-mcp'))).toEqual([]);
    }, 120_000);

    it('stops at once on a tailnet that has not allowed Serve, passing on its enable link', async () => {
      managedBeeper();
      host.set('serve-disabled');

      const run = await configure([], { CLAUDE_MESSENGER_SERVE_TIMEOUT: '1' });

      expect(run.code, why(run)).toBe(1);
      expect(run.stderr).toContain('https://login.tailscale.com/f/serve?node=nFAKE7');
      expect(host.surfaceClosed()).toBe(true);
      expect(mock.approvalRequests).toEqual([]);
    }, 90_000);

    it('still serves this host when the tailnet has not allowed Serve, passing on the enable link', async () => {
      host.set('serve-disabled');

      const run = await configure([], { CLAUDE_MESSENGER_SERVE_TIMEOUT: '1' });

      expect(run.code, why(run)).toBe(0);
      expect(run.stdout).toContain('https://login.tailscale.com/f/serve?node=nFAKE7');
      // The summary offers only what works: the loopback URL, not a tailnet one.
      expect(run.stdout).toContain(`URL:    http://127.0.0.1:${mcpPort}/mcp`);
      expect(run.stdout).not.toContain('ts.net/mcp');
      expect(host.has('serve-443')).toBe(false);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 90_000);

    it('still serves this host when sudo wants a password nobody can type, saying so', async () => {
      host.set('sudo-needs-password');

      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      expect(run.stdout).toContain('sudo: a password is required');
      expect(run.stdout).toContain(`URL:    http://127.0.0.1:${mcpPort}/mcp`);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 90_000);

    it('publishes to the tailnet when sudo asks for a password first', async () => {
      host.set('sudo-asks-password');

      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      expect(host.read('serve-443').trim()).toBe(String(mcpPort));
      expect(run.stdout).toContain('URL:    https://box.example-tailnet.ts.net/mcp');
    }, 90_000);

    it('never opens the sign-in screen for a Beeper it does not manage', async () => {
      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      expect(host.calls().filter((c) => c.includes('8443'))).toEqual([]);
      expect(mock.issuedTokens.has(envValue('BEEPER_ACCESS_TOKEN')!)).toBe(true);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 90_000);

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('completes a .env made by hand from .env.example, with %s line endings', async (_, eol) => {
      const example = readFileSync(join(REPO, '.env.example'), 'utf8');
      const filled = example.replace(/^BEEPER_BASE_URL=.*$/m, `BEEPER_BASE_URL=${beeperUrl}`);
      expect(filled).not.toBe(example);
      writeFileSync(join(install, '.env'), filled.replaceAll('\n', eol));

      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      const lines = envText().split(/\r?\n/);
      const assignments = (name: string) => lines.filter((l) => l.startsWith(`${name}=`));
      expect(assignments('CLAUDE_MESSENGER_MCP_TOKEN')).toEqual([
        expect.stringMatching(/^CLAUDE_MESSENGER_MCP_TOKEN=[0-9a-f]{64}$/),
      ]);
      expect(assignments('BEEPER_ACCESS_TOKEN')).toEqual([`BEEPER_ACCESS_TOKEN=${[...mock.issuedTokens.keys()][0]}`]);
      // Everything else in it, comments included, stays as written.
      for (const line of filled.split('\n').filter((l) => !/^(BEEPER_ACCESS_TOKEN|CLAUDE_MESSENGER_MCP_TOKEN)=/.test(l))) {
        expect(lines).toContain(line);
      }
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
      expectNoSecrets(run);
    }, 90_000);

    it('keeps the token in a .env made by hand, adding what the service needs and making it owner-only', async () => {
      // A token minted by hand in Beeper, in a file as an editor leaves it:
      // readable by others, with no newline at the end.
      mock.issuedTokens.set('minted-by-hand', { scope: 'read', revoked: false });
      writeFileSync(join(install, '.env'), `BEEPER_BASE_URL=${beeperUrl}\nBEEPER_ACCESS_TOKEN=minted-by-hand`);
      chmodSync(join(install, '.env'), 0o644);

      const run = await configure();

      expect(run.code, why(run)).toBe(0);
      expect(mock.approvalRequests).toEqual([]);
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBe('minted-by-hand');
      expect(envValue('CLAUDE_MESSENGER_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(install, '.env')).mode & 0o777).toBe(0o600);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 90_000);

    it('refuses to run as root, before changing anything', async () => {
      host.set('root');
      const homeMode = statSync(host.home).mode & 0o777;

      const run = await configure();

      expect(run.code, why(run)).toBe(1);
      expect(run.stderr).toContain('not root');
      expect(existsSync(join(install, '.env'))).toBe(false);
      expect(statSync(host.home).mode & 0o777).toBe(homeMode);
      expect(mock.requests).toEqual([]);
    }, 90_000);

    it('asks for nothing on a re-run, and gets a new token only when told to reconnect', async () => {
      expect((await configure()).code).toBe(0);
      const first = envValue('BEEPER_ACCESS_TOKEN');

      const rerun = await configure();

      expect(rerun.code, why(rerun)).toBe(0);
      expect(rerun.stdout).toContain('Beeper token already in .env');
      expect(mock.approvalRequests).toHaveLength(1);
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBe(first);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');

      const reconnect = await configure(['--reconnect']);

      expect(reconnect.code, why(reconnect)).toBe(0);
      expect(mock.approvalRequests).toHaveLength(2);
      expect(envValue('BEEPER_ACCESS_TOKEN')).not.toBe(first);
      expect(reconnect.stdout).toContain('replaced an earlier token');
      expect(reconnect.stdout).not.toContain("also set in this command's environment");
      expectNoSecrets(reconnect);
      // Only a service restarted onto the new token still answers once the old one is revoked.
      mock.issuedTokens.get(first!)!.revoked = true;
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 120_000);
  });

  describe('deploy/bootstrap.sh', () => {
    const bootstrap = () => join(REPO, 'deploy', 'bootstrap.sh');

    it('runs end to end with no terminal, never letting apt stop to ask', async () => {
      const run = await host.runDetached('bash', [bootstrap()], settings());

      expect(run.code, why(run)).toBe(0);
      const apt = host.calls().filter((c) => c.startsWith('apt-get '));
      expect(apt.length).toBeGreaterThan(0);
      for (const call of apt) expect(call).toContain('[DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a]');
      expect(host.calls()).toEqual(
        expect.arrayContaining([
          `git -C ${install} pull --ff-only`,
          'npm ci --no-audit --no-fund',
          'npm run build',
        ]),
      );
      // It finished through configure.sh: token saved, service answering.
      expect(mock.issuedTokens.has(envValue('BEEPER_ACCESS_TOKEN')!)).toBe(true);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
      expectNoSecrets(run);
    }, 120_000);

    it('stops configure.sh, and its wait for approval, when only bootstrap is stopped', async () => {
      mock.decide = () => 'no-answer';
      const run = host.startDetached('bash', [bootstrap()], settings());
      await until(() => mock.openBoxes === 1, 'the approval box to open', run);

      // bootstrap alone, the script a session started.
      process.kill(run.child.pid!, 'SIGTERM');
      const result = await doneWithin(run, 10_000);

      expect(result.code, why(result)).toBe(130);
      await until(() => mock.openBoxes === 0, 'connect to stop waiting on the box');
    }, 90_000);

    it("takes a Beeper with its Desktop API switched off as running, and waits for it to be switched on", async () => {
      mock.apiDisabled = true;
      const run = host.startDetached('bash', [bootstrap()], settings());

      await until(() => run.output().includes("Beeper's Desktop API is switched off"), 'connect to ask for it', run);
      mock.apiDisabled = false;
      const result = await run.done;

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain('already serving');
      expect(mock.issuedTokens.has(envValue('BEEPER_ACCESS_TOKEN')!)).toBe(true);
      expect(await listAccountsOverHttp()).toContain('whatsapp-1');
    }, 120_000);
  });
});
