import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBeeperServer } from './mock-beeper.js';

const exec = promisify(execFile);

const OWNER = '@owner:beeper.local';

/**
 * `start-chat` as the assistant runs it to open its chat with the owner: the
 * real CLI as a subprocess, against a mock Beeper signed in to an account
 * with no chats yet, as the assistant's new one is.
 */
describe('start-chat (subprocess integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let dir: string;

  const cli = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const { stdout, stderr } = await exec('npx', ['tsx', 'src/cli/main.ts', ...args], {
        cwd: join(import.meta.dirname, '..'),
        env: {
          ...process.env,
          BEEPER_ACCESS_TOKEN: mock.token,
          BEEPER_BASE_URL: baseUrl,
          CLAUDE_MESSENGER_POLICY: join(dir, 'policy.json'),
          CLAUDE_MESSENGER_AUDIT_DIR: join(dir, 'audit'),
          CLAUDE_MESSENGER_STATE_DIR: join(dir, 'state'),
        },
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  const allowStartingChatsWith = (users: string[]) =>
    writeFile(
      join(dir, 'policy.json'),
      JSON.stringify({ version: 1, capabilities: { read: true, startChat: true }, startChat: { userAllowlist: users } }),
    );

  const starts = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1/chats/start');

  const auditEntries = async () => {
    const files = (await readdir(join(dir, 'audit'))).filter((f) => f.startsWith('audit-'));
    const raw = (await Promise.all(files.map((f) => readFile(join(dir, 'audit', f), 'utf8')))).join('');
    return raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.accounts = [{ accountID: 'matrix', network: 'Beeper' }];
    mock.self = { id: '@claude:beeper.local', fullName: 'Claude' };
    dir = await mkdtemp(join(tmpdir(), 'claude-messenger-start-chat-'));
  });

  afterEach(async () => {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('is denied under the default policy, naming the rule, and never reaches Beeper', async () => {
    const { stderr, code } = await cli(['start-chat', '--with', OWNER]);

    expect(code).toBe(1);
    expect(stderr).toContain('Denied by policy rule capabilities.startChat');
    expect(starts()).toEqual([]);
    expect(await auditEntries()).toContainEqual(
      expect.objectContaining({ action: 'startDirectChat', decision: 'denied', rule: 'capabilities.startChat' }),
    );
  }, 30_000);

  it('opens a direct chat with someone the policy names, on the only account, inviting them, and prints its ID', async () => {
    await allowStartingChatsWith([OWNER]);

    const { stdout, stderr, code } = await cli(['start-chat', '--with', OWNER]);

    expect(code, stderr).toBe(0);
    const [chat] = mock.chats;
    expect(mock.chats).toHaveLength(1);
    expect(chat!.participants.items.map((p) => p.id)).toEqual(['@claude:beeper.local', OWNER]);
    expect(stdout).toContain(`✓ Direct chat with ${OWNER}: ${chat!.id}`);
    expect(starts().map((r) => r.body)).toEqual([{ accountID: 'matrix', user: { id: OWNER }, allowInvite: true }]);

    // The doctor says what the policy allows.
    const doctor = await cli(['doctor']);
    expect(doctor.stdout).toContain('startChat: true');
    expect(doctor.stdout).toContain('start-chat allowlist: 1 person(s)');

    // Who it was with is on record before Beeper was asked, and the chat after.
    const entries = (await auditEntries()).filter((e) => e.action === 'startDirectChat');
    expect(entries).toEqual([
      expect.objectContaining({ stage: 'intent', context: { accountId: 'matrix', userId: OWNER } }),
      expect.objectContaining({ stage: 'outcome', outcome: 'ok', context: { accountId: 'matrix', userId: OWNER, chatId: chat!.id } }),
    ]);
  }, 30_000);

  it('opens the same chat when run again, rather than a second', async () => {
    await allowStartingChatsWith([OWNER]);

    const first = await cli(['start-chat', '--with', OWNER]);
    const again = await cli(['start-chat', '--with', OWNER]);

    expect(again.code, again.stderr).toBe(0);
    expect(mock.chats).toHaveLength(1);
    expect(again.stdout).toContain(`: ${mock.chats[0]!.id} `);
    expect(first.stdout).toBe(again.stdout);
  }, 30_000);

  it('refuses someone the policy does not name, before Beeper hears of them', async () => {
    await allowStartingChatsWith([OWNER]);

    const { stderr, code } = await cli(['start-chat', '--with', '@stranger:beeper.local']);

    expect(code).toBe(1);
    expect(stderr).toContain('Denied by policy rule startChat.userAllowlist');
    expect(starts()).toEqual([]);
    expect(mock.chats).toEqual([]);
  }, 30_000);

  it('asks which account to open it on when there are several, opening nothing', async () => {
    await allowStartingChatsWith([OWNER]);
    mock.accounts = [
      { accountID: 'matrix', network: 'Beeper' },
      { accountID: 'signal', network: 'Signal' },
    ];

    const { stderr, code } = await cli(['start-chat', '--with', OWNER]);

    expect(code).toBe(1);
    expect(stderr).toContain('There are 2 accounts here: name one with --account');
    expect(starts()).toEqual([]);

    const named = await cli(['start-chat', '--with', OWNER, '--account', 'matrix']);
    expect(named.code, named.stderr).toBe(0);
    expect(starts().map((r) => (r.body as { accountID: string }).accountID)).toEqual(['matrix']);
  }, 30_000);
});
