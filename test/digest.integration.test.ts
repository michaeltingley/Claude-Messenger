import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeClaudeShim, type Shim } from './claude-code-shim.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

const exec = promisify(execFile);

/** An ISO time this many hours before now. */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const ANSWER = '**Needs you**\n- **Alice** asked about dinner on Friday.\n\n**Everything else**\n- **Family**: the cabin is booked.';

/**
 * `digest` end to end: the real CLI as a subprocess, reading a mock Beeper
 * over HTTP through the policy layer, and handing the briefing to a
 * stand-in Claude Code found on PATH, as the real one is.
 */
describe('claude-messenger digest (subprocess integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let stateDir: string;
  let claude: Shim;

  const cli = async (args: string[], shim: Shim = claude, env: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await exec('npx', ['tsx', 'src/cli/main.ts', 'digest', ...args], {
        cwd: join(import.meta.dirname, '..'),
        env: {
          ...process.env,
          PATH: `${shim.dir}:${process.env.PATH ?? ''}`,
          BEEPER_ACCESS_TOKEN: mock.token,
          BEEPER_BASE_URL: baseUrl,
          CLAUDE_MESSENGER_POLICY: join(stateDir, 'policy.json'),
          CLAUDE_MESSENGER_AUDIT_DIR: join(stateDir, 'audit'),
          CLAUDE_MESSENGER_STATE_DIR: join(stateDir, 'state'),
          ...env,
        },
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  const auditText = async () => {
    const dir = join(stateDir, 'audit');
    const files = await readdir(dir);
    return (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('');
  };

  beforeAll(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
  }, 30_000);

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'claude-messenger-digest-'));
    claude = await writeClaudeShim({ stdout: `${ANSWER}\n` });
    mock.requests = [];
    mock.chats = [
      wireChat({ id: '!alice', title: 'Alice', lastActivity: ago(2), unreadCount: 1 }),
      wireChat({
        id: '!family',
        title: 'Family',
        type: 'group',
        lastActivity: ago(5),
        unreadCount: 0,
        participants: { items: [{ id: 'mom', fullName: 'Mom' }, { id: 'me' }], hasMore: false, total: 2 },
      }),
      wireChat({ id: '!old', title: 'Old friend', lastActivity: ago(48), unreadCount: 0 }),
      wireChat({ id: '!archived', title: 'Archived', lastActivity: ago(1), isArchived: true }),
      wireChat({ id: '!promos', title: 'Promos', lastActivity: ago(1), isLowPriority: true }),
    ];
    mock.messages = [
      wireMessage({ id: 'a0', chatID: '!alice', isSender: true, senderName: 'Me', timestamp: ago(30), text: 'Free this week?' }),
      wireMessage({ id: 'a1', chatID: '!alice', timestamp: ago(3), text: 'Dinner on <b>Friday</b>?' }),
      wireMessage({ id: 'a2', chatID: '!alice', timestamp: ago(2), text: 'I can book the place' }),
      wireMessage({ id: 'f1', chatID: '!family', senderID: 'mom', senderName: 'Mom', timestamp: ago(5), text: 'Cabin is booked' }),
      wireMessage({ id: 'o1', chatID: '!old', timestamp: ago(48), text: 'long time no see' }),
      wireMessage({ id: 'x1', chatID: '!archived', timestamp: ago(1), text: 'archived words' }),
      wireMessage({ id: 'p1', chatID: '!promos', timestamp: ago(1), text: 'SALE 50% off' }),
    ];
  });

  afterAll(async () => {
    await mock.stop();
  });

  it('prints what Claude wrote, then what the digest covers', async () => {
    const { stdout, code } = await cli(['--time-zone', 'America/Los_Angeles']);
    expect(code).toBe(0);
    expect(stdout).toContain(ANSWER);
    expect(stdout.trimEnd().split('\n').at(-1)).toMatch(/^_Covers 2 chats and 3 messages since \w{3}, \w{3} \d+, \d+:\d\d [AP]M\._$/);
  }, 30_000);

  it("briefs Claude on stdin with the last day of the main inbox's chats, the words of the messages and a little context", async () => {
    await cli(['--time-zone', 'America/Los_Angeles']);
    const [call] = await claude.calls();
    expect(call!.stdin).toContain('## Alice');
    expect(call!.stdin).toContain('Alice: Dinner on Friday?');
    expect(call!.stdin).toContain('Alice: I can book the place');
    expect(call!.stdin).toContain('You: Free this week?'); // from before the window, for context
    expect(call!.stdin).toContain('Mom: Cabin is booked');
    expect(call!.stdin).toContain('in America/Los_Angeles');
    for (const outside of ['long time no see', 'archived words', 'SALE']) expect(call!.stdin).not.toContain(outside);
  }, 30_000);

  it('never lets Claude see the Beeper token, and keeps the messages off its command line', async () => {
    await cli([]);
    const [call] = await claude.calls();
    expect(Object.keys(call!.env)).not.toContain('BEEPER_ACCESS_TOKEN');
    expect(JSON.stringify(call!.env)).not.toContain(mock.token);
    expect(call!.argv.join(' ')).not.toContain('Dinner');
  }, 30_000);

  it('writes with Sonnet unless told which model to use', async () => {
    await cli([]);
    await cli(['--model', 'opus']);
    const [byDefault, chosen] = await claude.calls();
    expect(byDefault!.argv[byDefault!.argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(chosen!.argv[chosen!.argv.indexOf('--model') + 1]).toBe('opus');
  }, 30_000);

  it('covers only as many hours back as it is told', async () => {
    await cli(['--hours', '4']);
    const [call] = await claude.calls();
    expect(call!.stdin).toContain('I can book the place');
    expect(call!.stdin).not.toContain('Cabin is booked'); // 5 hours ago
  }, 30_000);

  it("audits the reads it makes, and none of the messages' words", async () => {
    await cli([]);
    const audit = await auditText();
    expect(audit).toContain('"action":"searchChats"');
    expect(audit).toContain('"action":"listMessages"');
    for (const words of ['Dinner', 'book the place', 'Cabin', ANSWER]) expect(audit).not.toContain(words);
  }, 30_000);

  it('says there is nothing new, without starting Claude Code, when no chat had messages', async () => {
    mock.chats = [wireChat({ lastActivity: ago(48) })];
    const { stdout, code } = await cli([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^_No new messages since .+\._\n$/);
    expect(await claude.calls()).toEqual([]);
  }, 30_000);

  it("fails with Claude Code's reason when it can't answer, and prints no digest", async () => {
    const signedOut = await writeClaudeShim({ stderr: 'Not logged in · Please run /login\n', exitCode: 1 });
    const { stdout, stderr, code } = await cli([], signedOut);
    expect(code).toBe(1);
    expect(stderr).toContain('✗ [model_failed] Claude Code failed (exit 1): Not logged in · Please run /login');
    expect(stdout).toBe('');
  }, 30_000);

  it('fails with the checklist when Beeper is unreachable, and never starts Claude Code', async () => {
    const { stderr, code } = await cli([], claude, { BEEPER_BASE_URL: 'http://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(stderr).toContain('connection_failed');
    expect(stderr).toContain('Checklist');
    expect(await claude.calls()).toEqual([]);
  }, 30_000);

  it.each([
    [['--time-zone', 'Mars/Olympus_Mons'], 'must be an IANA time zone'],
    [['--hours', '0'], 'whole number of hours from 1 to 168'],
    [['--hours', '169'], 'whole number of hours from 1 to 168'],
    [['--hours', '1.5'], 'whole number of hours from 1 to 168'],
  ])('refuses %j before reading anything', async (args, error) => {
    const { stderr, code } = await cli(args);
    expect(code).not.toBe(0);
    expect(stderr).toContain(error);
    expect(mock.requests).toHaveLength(0);
    expect(await claude.calls()).toEqual([]);
  }, 30_000);
});
