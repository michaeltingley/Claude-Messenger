import { execFileSync } from 'node:child_process';
import {
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
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost, type ScriptResult } from './fake-host.js';
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

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
    mcpPort = await freePort();
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
  const configure = (args: string[] = [], extra: Record<string, string> = {}) =>
    host.runDetached('bash', [join(install, 'deploy', 'configure.sh'), ...args], settings(extra));

  /** Beeper Desktop installed by bootstrap: headless, its window only on the sign-in surface. */
  const managedBeeper = () => {
    mkdirSync(host.unitDir, { recursive: true });
    writeFileSync(join(host.unitDir, 'beeper-desktop.service'), '[Service]\n');
  };

  const envText = () => readFileSync(join(install, '.env'), 'utf8');
  const envValue = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(envText())?.[1];

  /** Ask the installed MCP service, as a Claude session on the host would. */
  const listAccountsOverMcp = async (): Promise<string> => {
    const client = new Client({ name: 'install-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${envValue('CLAUDE_MESSENGER_MCP_TOKEN')}` } },
      }),
    );
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      return (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    } finally {
      await client.close();
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

      expect(run.code, run.stderr).toBe(0);
      // The person gets the screen first, then what to do on it.
      expect(run.stdout).toMatch(
        /vnc\.html#autoconnect=1&password=[\s\S]*Approve the connection in Beeper's own window[\s\S]*✓ Approved \(read only\)[\s\S]*sign-in surface closed/,
      );
      expect(host.surfaceClosed()).toBe(true);

      const token = envValue('BEEPER_ACCESS_TOKEN');
      expect(token).toBeDefined();
      expect(mock.issuedTokens.get(token!)).toEqual({ scope: 'read', revoked: false });
      expect(envValue('CLAUDE_MESSENGER_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(install, '.env')).mode & 0o777).toBe(0o600);
      expect(existsSync(join(install, 'policy.json'))).toBe(true);
      expectNoSecrets(run);

      // The service systemd started uses the token connect saved, end to end.
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');
      expect(host.read('serve-443').trim()).toBe(String(mcpPort));
      expect(run.stdout).toContain('URL:    https://box.example-tailnet.ts.net/mcp');
      expect(host.read('claude-mcp').split('\n').filter(Boolean)).toEqual([
        '--scope',
        'user',
        '--transport',
        'http',
        'claude-messenger',
        `http://127.0.0.1:${mcpPort}/mcp`,
        '--header',
        `Authorization: Bearer ${envValue('CLAUDE_MESSENGER_MCP_TOKEN')}`,
      ]);
    }, 90_000);

    it('closes the Beeper screen and starts nothing when the approval is declined', async () => {
      managedBeeper();
      mock.decide = () => ({ approve: false });

      const run = await configure();

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('[access_denied]');
      expect(run.stderr).toContain('run configure.sh again');
      expect(host.surfaceClosed()).toBe(true);
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBeUndefined();
      expect(existsSync(join(host.unitDir, 'claude-messenger-mcp.service'))).toBe(false);
      expect(readdirSync(join(host.state, 'pids'))).toEqual([]);
    }, 90_000);

    it('stops at once on a tailnet that has not allowed Serve, passing on its enable link', async () => {
      managedBeeper();
      host.set('serve-disabled');

      const run = await configure([], { CLAUDE_MESSENGER_SERVE_TIMEOUT: '1' });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('https://login.tailscale.com/f/serve?node=nFAKE7');
      expect(host.surfaceClosed()).toBe(true);
      expect(mock.approvalRequests).toEqual([]);
    }, 90_000);

    it('still serves this host when the tailnet has not allowed Serve, passing on the enable link', async () => {
      host.set('serve-disabled');

      const run = await configure([], { CLAUDE_MESSENGER_SERVE_TIMEOUT: '1' });

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('https://login.tailscale.com/f/serve?node=nFAKE7');
      // The summary offers only what works: the loopback URL, not a tailnet one.
      expect(run.stdout).toContain(`URL:    http://127.0.0.1:${mcpPort}/mcp`);
      expect(run.stdout).not.toContain('ts.net/mcp');
      expect(host.has('serve-443')).toBe(false);
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');
    }, 90_000);

    it('never opens the sign-in screen for a Beeper it does not manage', async () => {
      const run = await configure();

      expect(run.code, run.stderr).toBe(0);
      expect(host.calls().filter((c) => c.includes('8443'))).toEqual([]);
      expect(mock.issuedTokens.has(envValue('BEEPER_ACCESS_TOKEN')!)).toBe(true);
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');
    }, 90_000);

    it('asks for nothing on a re-run, and gets a new token only when told to reconnect', async () => {
      expect((await configure()).code).toBe(0);
      const first = envValue('BEEPER_ACCESS_TOKEN');

      const rerun = await configure();

      expect(rerun.code, rerun.stderr).toBe(0);
      expect(rerun.stdout).toContain('Beeper token already in .env');
      expect(mock.approvalRequests).toHaveLength(1);
      expect(envValue('BEEPER_ACCESS_TOKEN')).toBe(first);
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');

      const reconnect = await configure(['--reconnect']);

      expect(reconnect.code, reconnect.stderr).toBe(0);
      expect(mock.approvalRequests).toHaveLength(2);
      expect(envValue('BEEPER_ACCESS_TOKEN')).not.toBe(first);
      expect(reconnect.stdout).toContain('replaced an earlier token');
      expectNoSecrets(reconnect);
      // The restarted service picked up the new token.
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');
    }, 120_000);
  });

  describe('deploy/bootstrap.sh', () => {
    it('runs end to end with no terminal, never letting apt stop to ask', async () => {
      const run = await host.runDetached('bash', [join(REPO, 'deploy', 'bootstrap.sh')], settings());

      expect(run.code, run.stderr).toBe(0);
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
      expect(await listAccountsOverMcp()).toContain('whatsapp-1');
      expectNoSecrets(run);
    }, 120_000);
  });
});
