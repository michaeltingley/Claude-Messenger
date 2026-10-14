import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
          CLAUDE_MESSENGER_STATE_DIR: join(stateDir, 'state'),
          ...envOverrides,
        },
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
    }
  };

  /** What the run left in its audit trail: the files' text, and each entry. */
  const auditTrail = async () => {
    const dir = join(stateDir, 'audit');
    const files = (await readdir(dir)).filter((f) => f.startsWith('audit-'));
    const raw = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('');
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { raw, entries };
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

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
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

  it('messages and search print each message as its chat shows it: the words, without the markup of a reply or formatting', async () => {
    mock.messages = [
      wireMessage(),
      wireMessage({
        id: 'msg-2',
        sortKey: '2',
        timestamp: '2026-07-09T12:05:00.000Z',
        // A reply, as Beeper gives it: HTML, carrying a copy of the message it answers.
        text: '<mx-reply><blockquote>In reply to <a href="https://matrix.to/#/@me:beeper.com">Me</a><br>Free?</blockquote></mx-reply>Dinner on <b>Friday</b>?',
      }),
      wireMessage({
        id: 'msg-3',
        sortKey: '3',
        timestamp: '2026-07-09T12:10:00.000Z',
        // A plain-text reply, as Matrix's reply fallback writes one: the copy, a blank line, then the reply.
        text: '> <@me:beeper.com> See you at 8?\n> Or later?\n\nworks for me',
      }),
    ];
    try {
      const messages = await cli(['messages', '!chat1:beeper.com']);
      expect(messages.code).toBe(0);
      expect(messages.stdout.trimEnd().split('\n')).toEqual([
        '[2026-07-09T12:00:00.000Z] Alice: hello from alice',
        '[2026-07-09T12:05:00.000Z] Alice: Dinner on Friday?',
        '[2026-07-09T12:10:00.000Z] Alice: works for me',
      ]);
      const search = await cli(['search', 'friday']);
      expect(search.code).toBe(0);
      expect(search.stdout.trimEnd()).toBe('[2026-07-09T12:05:00.000Z] (!chat1:beeper.com) Alice: Dinner on Friday?');
    } finally {
      mock.messages = [wireMessage()];
    }
  }, 30_000);

  it('search finds matches in low-priority and muted chats too', async () => {
    mock.chats = [
      wireChat(),
      wireChat({ id: '!lowprio:beeper.com', title: 'Low priority', isLowPriority: true }),
      wireChat({ id: '!muted:beeper.com', title: 'Muted', isMuted: true }),
    ];
    mock.messages = [
      wireMessage({ id: 'in-inbox', text: 'lunch tomorrow', timestamp: '2026-10-01T00:03:00.000Z' }),
      wireMessage({ id: 'in-lowprio', chatID: '!lowprio:beeper.com', text: 'lunch at noon', timestamp: '2026-10-01T00:02:00.000Z' }),
      wireMessage({ id: 'in-muted', chatID: '!muted:beeper.com', text: 'lunch is on me', timestamp: '2026-10-01T00:01:00.000Z' }),
    ];
    try {
      const { stdout, code } = await cli(['search', 'lunch']);
      expect(code).toBe(0);
      expect(stdout.trimEnd().split('\n')).toEqual([
        '[2026-10-01T00:03:00.000Z] (!chat1:beeper.com) Alice: lunch tomorrow',
        '[2026-10-01T00:02:00.000Z] (!lowprio:beeper.com) Alice: lunch at noon',
        '[2026-10-01T00:01:00.000Z] (!muted:beeper.com) Alice: lunch is on me',
      ]);
    } finally {
      mock.chats = [wireChat()];
      mock.messages = [wireMessage()];
    }
  }, 30_000);

  /**
   * What a listing printed: its lines, and the cursor its last line says to
   * run again with, as a shell would pass it on.
   */
  const listing = async (stdout: string): Promise<{ lines: string[]; cursor?: string }> => {
    const lines = stdout.trimEnd().split('\n').filter(Boolean);
    const hint = /^\(more available — run again with --cursor (.+)\)$/.exec(lines.at(-1) ?? '');
    if (hint === null) return { lines };
    const { stdout: cursor } = await exec('sh', ['-c', `printf %s ${hint[1]}`]);
    return { lines: lines.slice(0, -1), cursor };
  };

  describe('search, past what one page holds', () => {
    const ALL = 45;
    /** Message `i` of those `search needle` finds, a minute after message i - 1. */
    const needle = (i: number, chatID = '!chat1:beeper.com') =>
      wireMessage({ id: `n${i}`, chatID, text: `needle ${i}`, timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
    /** The numbers of the needles a listing printed, after checking each line is one from the readable chat. */
    const numbers = (lines: string[]) =>
      lines.map((line) => {
        const match = /^\[[^\]]+\] \(!chat1:beeper\.com\) Alice: needle (\d+)$/.exec(line);
        expect(match, line).not.toBeNull();
        return Number(match![1]);
      });
    /** from, from - 1, … to: newest first. */
    const down = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, k) => from - k);
    const searches = () => mock.requests.filter((r) => r.path === '/v1/messages/search');

    afterEach(() => {
      mock.messages = [wireMessage()];
      mock.shapeMessageSearch = undefined;
    });

    it('prints as many as -n asks for from as many pages as it takes, newest first, then the cursor to the rest', async () => {
      mock.messages = Array.from({ length: ALL }, (_, i) => needle(i));
      const first = await cli(['search', 'needle', '-n', '30']);
      expect(first.code).toBe(0);
      const page = await listing(first.stdout);
      expect(numbers(page.lines)).toEqual(down(44, 15));
      expect(page.cursor).toBeDefined();

      const rest = await cli(['search', 'needle', '-n', '30', '--cursor', page.cursor!]);
      expect(rest.code).toBe(0);
      const last = await listing(rest.stdout);
      expect(numbers(last.lines)).toEqual(down(14, 0));
      expect(last.cursor).toBeUndefined();

      // Ten unless told otherwise, and no hint once nothing is left.
      const byDefault = await listing((await cli(['search', 'needle'])).stdout);
      expect(numbers(byDefault.lines)).toEqual(down(44, 35));
      expect(byDefault.cursor).toBeDefined();
      const everything = await listing((await cli(['search', 'needle', '-n', '50'])).stdout);
      expect(numbers(everything.lines)).toEqual(down(44, 0));
      expect(everything.cursor).toBeUndefined();
    }, 60_000);

    it('reads on past the matches the policy hides to fill -n, and never prints them', async () => {
      await writeFile(join(stateDir, 'policy.json'), JSON.stringify({ version: 1, read: { chatDenylist: ['!secret:beeper.com'] } }));
      // Every other match is in the hidden chat.
      mock.messages = Array.from({ length: 30 }, (_, i) => needle(i, i % 2 === 0 ? '!chat1:beeper.com' : '!secret:beeper.com'));
      const first = await listing((await cli(['search', 'needle', '-n', '10'])).stdout);
      expect(numbers(first.lines)).toEqual([28, 26, 24, 22, 20, 18, 16, 14, 12, 10]);
      expect(first.cursor).toBeDefined();
      const rest = await listing((await cli(['search', 'needle', '-n', '10', '--cursor', first.cursor!])).stdout);
      expect(numbers(rest.lines)).toEqual([8, 6, 4, 2, 0]);
      expect(rest.cursor).toBeUndefined();
    }, 60_000);

    it('says more match when Beeper gives no cursor to them, printing what it has once, without asking again', async () => {
      mock.messages = Array.from({ length: ALL }, (_, i) => needle(i));
      mock.shapeMessageSearch = (page) => ({ ...page, oldestCursor: null });
      const run = await cli(['search', 'needle', '-n', '30']);
      expect(run.code).toBe(0);
      const page = await listing(run.stdout);
      expect(page.lines.at(-1)).toBe('(more available, with no cursor to get them)');
      expect(numbers(page.lines.slice(0, -1))).toEqual(down(44, 25));
      expect(searches()).toHaveLength(1);
    }, 30_000);

    it('stops paging through match after match the policy hides, with the cursor to go on from there', async () => {
      await writeFile(join(stateDir, 'policy.json'), JSON.stringify({ version: 1, read: { chatDenylist: ['!secret:beeper.com'] } }));
      const HIDDEN = 120;
      // The three oldest matches are readable; every newer one is hidden.
      mock.messages = Array.from({ length: 3 + HIDDEN }, (_, i) => needle(i, i < 3 ? '!chat1:beeper.com' : '!secret:beeper.com'));
      const printed: number[] = [];
      const asked: number[] = [];
      let cursor: string | undefined;
      do {
        mock.requests = [];
        const run = await cli(['search', 'needle', '-n', '5', ...(cursor === undefined ? [] : ['--cursor', cursor])]);
        expect(run.code).toBe(0);
        const page = await listing(run.stdout);
        printed.push(...numbers(page.lines));
        asked.push(searches().length);
        cursor = page.cursor;
      } while (cursor !== undefined && asked.length < 10);
      expect(printed).toEqual([2, 1, 0]);
      // Reading every hidden match five at a time would take 24 pages: a run
      // reads a few of them, then hands over the cursor, printing nothing.
      expect(asked.length).toBeGreaterThan(1);
      for (const pages of asked) expect(pages).toBeLessThan(HIDDEN / 5);
    }, 60_000);
  });

  it('chats says how to get the rest when more remain, with a cursor a shell passes on as it is', async () => {
    // Beeper's cursors are its own, so this one holds what a shell would otherwise read as syntax.
    const odd = wireChat({ id: "!it's a|$trap:beeper.com", title: 'Odd' });
    const bob = wireChat({ id: '!chat2:beeper.com', accountID: 'signal-1', network: 'signal', title: 'Bob', lastActivity: '2026-07-08T12:00:00.000Z' });
    mock.chats = [odd, bob];
    try {
      const first = await cli(['chats', '-n', '1']);
      expect(first.code).toBe(0);
      const page = await listing(first.stdout);
      expect(page.lines).toEqual([odd.id, '    whatsapp · single · Odd  [2 unread]']);
      expect(page.cursor).toBeDefined();
      const rest = await cli(['chats', '-n', '1', '--cursor', page.cursor!]);
      expect(rest.code).toBe(0);
      expect(await listing(rest.stdout)).toEqual({ lines: [bob.id, '    signal · single · Bob  [2 unread]'] });
    } finally {
      mock.chats = [wireChat()];
    }
  }, 30_000);

  it('send is denied by capabilities.send under the default read-only policy, audited, never reaching the wire', async () => {
    const { stderr, code } = await cli(['send', '!chat1:beeper.com', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toContain('policy_denied');
    expect(stderr).toContain('capabilities.send'); // the precise rule, not just any denial
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    const { entries } = await auditTrail();
    expect(
      entries.some(
        (e) => e.action === 'sendMessage' && e.decision === 'denied' && e.rule === 'capabilities.send',
      ),
    ).toBe(true);
  }, 30_000);

  it("prints Beeper's failure for the person, but keeps Beeper's text, which can quote a message, out of the audit file", async () => {
    mock.forcedError = { status: 500, message: 'cannot render "meet me behind the mill at 8"' };
    try {
      const { stderr, code } = await cli(['messages', '!chat1:beeper.com']);
      expect(code).toBe(1);
      expect(stderr).toContain('[provider_error]');
      expect(stderr).toContain('behind the mill');
    } finally {
      mock.forcedError = undefined;
    }
    const { raw, entries } = await auditTrail();
    expect(entries).toContainEqual(
      expect.objectContaining({ action: 'listMessages', decision: 'allowed', outcome: 'error', error: 'provider_error' }),
    );
    expect(raw).not.toContain('behind the mill');
  }, 30_000);

  it('serve --http refuses to start without an MCP auth token', async () => {
    const { stderr, code } = await cli(['serve', '--http'], { CLAUDE_MESSENGER_MCP_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('CLAUDE_MESSENGER_MCP_TOKEN');
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
