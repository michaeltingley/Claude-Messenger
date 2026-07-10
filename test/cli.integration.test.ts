import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

const exec = promisify(execFile);

/**
 * CLI integration: the real claude-messenger binary as a subprocess against
 * a live mock endpoint — config loading, exit codes, output, policy files,
 * and the audit/rate-limit files it leaves behind.
 */
describe('CLI (subprocess integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let stateDir: string;

  const cli = async (
    args: string[],
    envOverrides: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const { stdout, stderr } = await exec('npx', ['tsx', 'src/cli/main.ts', ...args], {
        cwd: join(import.meta.dirname, '..'),
        env: {
          ...process.env,
          BEEPER_ACCESS_TOKEN: mock.token,
          BEEPER_BASE_URL: baseUrl,
          CLAUDE_MESSENGER_POLICY: join(stateDir, 'policy.json'),
          CLAUDE_MESSENGER_AUDIT_DIR: join(stateDir, 'audit'),
          ...envOverrides,
        },
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  beforeAll(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.chats = [wireChat()];
    mock.messages = [wireMessage()];
    stateDir = await mkdtemp(join(tmpdir(), 'claude-messenger-cli-'));
  }, 30_000);

  afterAll(async () => {
    await mock.stop();
  });

  it('doctor walks the whole chain and reports success', async () => {
    const { stdout, code } = await cli(['doctor']);
    expect(code).toBe(0);
    expect(stdout).toContain('✓ Config OK');
    expect(stdout).toContain('✓ Connected: MockBeeper 9.9.9');
    expect(stdout).toContain('✓ Auth OK — 1 connected account(s)');
    expect(stdout).toContain('built-in default (read-only)');
    expect(stdout).toContain('All checks passed');
  }, 30_000);

  it('doctor fails actionably when the endpoint is down', async () => {
    const { stderr, code } = await cli(['doctor'], { BEEPER_BASE_URL: 'http://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(stderr).toContain('Checklist');
    expect(stderr).toContain('BEEPER_BASE_URL');
  }, 30_000);

  it('fails with guidance when the token is missing', async () => {
    const { stderr, code } = await cli(['chats'], { BEEPER_ACCESS_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('BEEPER_ACCESS_TOKEN');
    expect(stderr).toContain('docs/SETUP.md');
  }, 30_000);

  it('chats lists chats with IDs and unread counts', async () => {
    const { stdout, code } = await cli(['chats']);
    expect(code).toBe(0);
    expect(stdout).toContain('!chat1:beeper.com');
    expect(stdout).toContain('whatsapp · single · Alice  [2 unread]');
  }, 30_000);

  it('send is denied read-only by default, audited, and never reaches the wire', async () => {
    const before = mock.requests.filter((r) => r.method === 'POST').length;
    const { stderr, code } = await cli(['send', '!chat1:beeper.com', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toContain('policy_denied');
    expect(mock.requests.filter((r) => r.method === 'POST').length).toBe(before);

    const auditFiles = await readdir(join(stateDir, 'audit'));
    const entries = (
      await Promise.all(
        auditFiles
          .filter((f) => f.startsWith('audit-'))
          .map((f) => readFile(join(stateDir, 'audit', f), 'utf8')),
      )
    )
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.some((e) => e.action === 'sendMessage' && e.decision === 'denied')).toBe(true);
  }, 30_000);

  it('send succeeds once policy allows the chat, and the rate window file persists across processes', async () => {
    await writeFile(
      join(stateDir, 'policy.json'),
      JSON.stringify({
        version: 1,
        capabilities: { read: true, send: true, markRead: false },
        send: { chatAllowlist: ['!chat1:beeper.com'], maxMessagesPerHour: 1, maxCharsPerMessage: 100 },
      }),
    );
    const first = await cli(['send', '!chat1:beeper.com', 'hello']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('✓ Sent');

    // Fresh process, same state dir: the file-backed window must enforce the cap.
    const second = await cli(['send', '!chat1:beeper.com', 'hello again']);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('maxMessagesPerHour');
  }, 60_000);
});
