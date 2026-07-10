import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

const exec = promisify(execFile);

/**
 * CLI integration: the real claude-messenger binary as a subprocess against
 * a live mock endpoint — config loading, exit codes, output, policy files,
 * and the audit/rate-limit files it leaves behind. Each test gets its own
 * state dir so no test depends on another's leftovers.
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
  }, 30_000);

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'claude-messenger-cli-'));
    mock.requests = [];
  });

  afterAll(async () => {
    await mock.stop();
  });

  it('doctor walks the whole chain and reports success', async () => {
    const { stdout, code } = await cli(['doctor']);
    expect(code).toBe(0);
    expect(stdout).toContain('✓ Config OK');
    expect(stdout).toContain('✓ Connected: MockBeeper 9.9.9');
    expect(stdout).toContain('✓ Auth OK — 1 account(s) visible under the current policy');
    expect(stdout).toContain('built-in default (read-only)');
    expect(stdout).toContain('All checks passed');
  }, 30_000);

  it('doctor fails actionably when the endpoint is down', async () => {
    const { stderr, code } = await cli(['doctor'], { BEEPER_BASE_URL: 'http://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(stderr).toContain('Checklist');
    expect(stderr).toContain('BEEPER_BASE_URL');
  }, 30_000);

  it('doctor names the policy file when it is malformed instead of dumping a stack trace', async () => {
    await writeFile(join(stateDir, 'policy.json'), '{ not json');
    const { stderr, code } = await cli(['doctor']);
    expect(code).toBe(1);
    expect(stderr).toContain('policy_file_invalid');
    expect(stderr).toContain(join(stateDir, 'policy.json'));
    expect(stderr).not.toContain('at JSON.parse'); // no raw stack trace
  }, 30_000);

  it('fails with guidance when the token is missing', async () => {
    const { stderr, code } = await cli(['chats'], { BEEPER_ACCESS_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('BEEPER_ACCESS_TOKEN');
    expect(stderr).toContain('docs/SETUP.md');
  }, 30_000);

  it('rejects a non-numeric -n with a usage error instead of forwarding NaN to the provider', async () => {
    const { stderr, code } = await cli(['chats', '-n', 'ten']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('integer between 1 and 50');
    expect(mock.requests).toHaveLength(0);
  }, 30_000);

  it('chats lists chats with IDs and unread counts', async () => {
    const { stdout, code } = await cli(['chats']);
    expect(code).toBe(0);
    expect(stdout).toContain('!chat1:beeper.com');
    expect(stdout).toContain('whatsapp · single · Alice  [2 unread]');
  }, 30_000);

  it('send is denied by capabilities.send under the default read-only policy, audited, never reaching the wire', async () => {
    const { stderr, code } = await cli(['send', '!chat1:beeper.com', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toContain('policy_denied');
    expect(stderr).toContain('capabilities.send'); // the precise rule, not just any denial
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

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
    expect(
      entries.some(
        (e) => e.action === 'sendMessage' && e.decision === 'denied' && e.rule === 'capabilities.send',
      ),
    ).toBe(true);
  }, 30_000);

  it('send succeeds once policy allows the chat, and the rate window persists across processes', async () => {
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
    expect(second.stderr).toContain('send.maxMessagesPerHour');
  }, 60_000);
});
