import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat } from './mock-beeper.js';

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, '..');

/**
 * `connect` is how the Beeper token reaches a host: the person signs in and
 * approves in Beeper's own window, and the token goes straight into the env
 * file. These tests run the real CLI as a subprocess, from a scratch
 * directory the way an install runs it, against the mock's model of Beeper
 * Desktop. Besides what lands in the file, they check the property the
 * command exists for: the token never appears in anything it prints.
 * (The protocol itself is covered in beeper-access.integration.test.ts.)
 */
describe('connect (subprocess integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let dir: string;
  let envFile: string;

  /** The CLI in `dir`, with no token in its environment: it must get one itself. */
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BEEPER_BASE_URL: baseUrl,
      CLAUDE_MESSENGER_POLICY: join(dir, 'policy.json'),
      CLAUDE_MESSENGER_AUDIT_DIR: join(dir, 'audit'),
      CLAUDE_MESSENGER_STATE_DIR: join(dir, 'state'),
      ...env,
    };
    delete childEnv.BEEPER_ACCESS_TOKEN;
    try {
      const { stdout, stderr } = await exec(
        join(REPO, 'node_modules', '.bin', 'tsx'),
        [join(REPO, 'src', 'cli', 'main.ts'), ...args],
        { cwd: dir, env: childEnv },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  const issued = () => [...mock.issuedTokens.keys()];

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.chats = [wireChat()];
    dir = await mkdtemp(join(tmpdir(), 'claude-messenger-connect-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await mock.stop();
  });

  it('saves an approved read-only token owner-only, never prints it, and doctor then works with it', async () => {
    // What deploy/configure.sh writes before the token exists.
    await writeFile(envFile, `# written by configure\nBEEPER_BASE_URL=${baseUrl}\nCLAUDE_MESSENGER_MCP_TOKEN=abc\n`, {
      mode: 0o600,
    });

    const { stdout, stderr, code } = await cli(['connect']);

    expect(code, stderr).toBe(0);
    expect(issued()).toHaveLength(1);
    const token = issued()[0]!;
    expect(stdout + stderr).not.toContain(token);
    // The person's steps come first, then the wait, then the outcome.
    expect(stdout).toMatch(/Expires in: choose Never[\s\S]*leave it off[\s\S]*Waiting up to 15 min/);
    expect(stdout).toMatch(/The approval box is open[\s\S]*✓ Approved \(read only\)/);
    expect(mock.approvalRequests[0]).toMatchObject({ clientInfo: { name: 'Claude Messenger' }, scopes: ['read'] });

    expect(await readFile(envFile, 'utf8')).toBe(
      `# written by configure\nBEEPER_BASE_URL=${baseUrl}\nCLAUDE_MESSENGER_MCP_TOKEN=abc\nBEEPER_ACCESS_TOKEN=${token}\n`,
    );
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);

    // The saved token is the working credential: doctor runs on the file alone.
    const doctor = await cli(['doctor']);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain('All checks passed');
    expect(doctor.stdout + doctor.stderr).not.toContain(token);
  }, 60_000);

  it('asks for write access only when told to, and says how to grant it', async () => {
    const { stdout, stderr, code } = await cli(['connect', '--allow-send']);

    expect(code, stderr).toBe(0);
    expect(mock.approvalRequests[0]?.scopes).toEqual(['read', 'write']);
    expect(stdout).toContain('Allow sensitive actions: turn it on');
    expect(stdout).toContain('✓ Approved (read and write)');
    // No env file existed, so connect created one holding only the token.
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_ACCESS_TOKEN=${issued()[0]}\n`);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('keeps a read-only token when sending was asked for but withheld, and says sending will not work', async () => {
    mock.decide = () => ({ approve: true, scopes: ['read'] });

    const { stdout, stderr, code } = await cli(['connect', '--allow-send']);

    expect(code, stderr).toBe(0);
    expect(stdout).toContain('✓ Approved (read only)');
    expect(stdout).toContain('Sending was not allowed in the approval box');
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_ACCESS_TOKEN=${issued()[0]}\n`);
  }, 60_000);

  it('replaces an earlier token in place and says the old one still works until revoked', async () => {
    await writeFile(envFile, `BEEPER_BASE_URL=${baseUrl}\nBEEPER_ACCESS_TOKEN=old-token-123\n# keep me\n`);

    const { stdout, stderr, code } = await cli(['connect']);

    expect(code, stderr).toBe(0);
    expect(stdout).toContain('replaced an earlier token, which still works until you revoke it');
    expect(await readFile(envFile, 'utf8')).toBe(
      `BEEPER_BASE_URL=${baseUrl}\nBEEPER_ACCESS_TOKEN=${issued()[0]}\n# keep me\n`,
    );
  }, 60_000);

  it('tells the person to sign in, and waits for it before opening the box', async () => {
    mock.signedIn = false;

    const run = cli(['connect']);
    for (let i = 0; i < 400 && !mock.requests.some((r) => r.path === '/v1/app/setup'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    mock.signedIn = true;
    const { stdout, stderr, code } = await run;

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/Waiting for you to sign in\.\.\.\n[\s\S]*The approval box is open/);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_ACCESS_TOKEN=${issued()[0]}\n`);
  }, 60_000);

  it('saves nothing when the person declines, and says to approve next time', async () => {
    mock.decide = () => ({ approve: false });
    const before = `BEEPER_BASE_URL=${baseUrl}\n`;
    await writeFile(envFile, before);

    const { stderr, code } = await cli(['connect']);

    expect(code).toBe(1);
    expect(stderr).toContain('[access_denied]');
    expect(stderr).toContain('press Approve');
    expect(issued()).toEqual([]);
    expect(await readFile(envFile, 'utf8')).toBe(before);
  }, 60_000);

  it('saves nothing from an approval on terms it cannot keep, and the token is revoked', async () => {
    mock.decide = () => ({ approve: true, expiresInSeconds: 30 * 24 * 3600 });
    const before = `BEEPER_BASE_URL=${baseUrl}\n`;
    await writeFile(envFile, before);

    const { stdout, stderr, code } = await cli(['connect']);

    expect(code).toBe(1);
    expect(stderr).toContain('[access_mismatch]');
    expect(stderr).toContain('choose Never under Expires in');
    expect(mock.issuedTokens.get(issued()[0]!)?.revoked).toBe(true);
    expect(stdout + stderr).not.toContain(issued()[0]);
    expect(await readFile(envFile, 'utf8')).toBe(before);
  }, 60_000);

  it('revokes the approved token when it cannot be saved', async () => {
    // Something unwritable where the env file goes.
    await mkdir(envFile);

    const { stdout, stderr, code } = await cli(['connect']);

    expect(code).toBe(1);
    expect(stderr).toContain('Could not save the token');
    expect(stderr).toContain('It was revoked');
    expect(mock.issuedTokens.get(issued()[0]!)?.revoked).toBe(true);
    expect(stdout + stderr).not.toContain(issued()[0]);
  }, 60_000);

  it('gives up when nobody answers the box in time, with nothing saved', async () => {
    mock.decide = () => 'no-answer';

    const { stderr, code } = await cli(['connect', '--timeout', '0.02']);

    expect(code).toBe(1);
    expect(stderr).toContain('[access_timeout]');
    expect(stderr).toContain('within 1 s');
    await expect(stat(envFile)).rejects.toThrow();
  }, 60_000);

  it('fails actionably when Beeper Desktop is not reachable', async () => {
    const { stderr, code } = await cli(['connect'], { BEEPER_BASE_URL: 'http://127.0.0.1:1' });

    expect(code).toBe(1);
    expect(stderr).toContain('Cannot reach Beeper Desktop at http://127.0.0.1:1');
    await expect(stat(envFile)).rejects.toThrow();
  }, 60_000);
});
