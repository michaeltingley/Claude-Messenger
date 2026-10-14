import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeShim, type Shim, type ShimBehavior } from './claude-code-shim.js';
import { MockBeeperServer, wireChat, wireMessage, type WireMessage } from './mock-beeper.js';

const REPO = join(import.meta.dirname, '..');
/** tsx as a loader in the CLI's own node process, which then gets signals first-hand, as in production. */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const OWNER = '@owner:beeper.local';
const CLAUDE = '@claude:beeper.local';
const DM = '!dm:beeper.local';
const FAMILY = '!family:beeper.local';
const ANSWER = 'Dinner is at 8. Directions: bobs-place.example.com';
/** What the answer becomes once it is made safe to show. */
const SHOWN = 'Dinner is at 8. Directions: (link)';
/** A time as the answer's first line gives it. */
const TIME = String.raw`\w{3} \d{1,2}:\d{2} [AP]M`;

/**
 * `claude-messenger respond`, run as the owner runs it: the real CLI in a
 * subprocess, reading the owner's chats from one mock Beeper (their Beeper
 * Desktop) and answering from the assistant's own account on another (its
 * Beeper Server), with a stand-in Claude Code on PATH. It runs until a
 * signal stops it, so these tests add the owner's messages as they would
 * arrive and stop it as systemd does.
 */
describe('respond (subprocess integration)', { timeout: 60_000 }, () => {
  let owner: MockBeeperServer;
  let assistant: MockBeeperServer;
  let ownerUrl: string;
  let assistantUrl: string;
  let dir: string;
  let assistantDir: string;
  let claude: Shim;
  let child: ChildProcess | undefined;

  /** Starts the CLI; output accumulates while it runs, and `exited` settles with its exit code. */
  const start = (shim: Shim = claude) => {
    const run = { stdout: '', stderr: '', exitCode: undefined as number | null | undefined };
    child = spawn(
      process.execPath,
      ['--import', TSX, join(REPO, 'src', 'cli', 'main.ts'), 'respond', '--assistant', assistantDir, '--time-zone', 'America/Los_Angeles'],
      {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${shim.dir}:${process.env.PATH ?? ''}`,
          BEEPER_ACCESS_TOKEN: owner.token,
          BEEPER_BASE_URL: ownerUrl,
          BEEPER_POLL_INTERVAL_MS: '1000',
          CLAUDE_MESSENGER_POLICY: join(dir, 'policy.json'),
          CLAUDE_MESSENGER_AUDIT_DIR: join(dir, 'audit'),
          CLAUDE_MESSENGER_STATE_DIR: join(dir, 'state'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (chunk: Buffer) => (run.stdout += chunk));
    child.stderr!.on('data', (chunk: Buffer) => (run.stderr += chunk));
    const exited = new Promise<number | null>((resolve) =>
      child!.on('exit', (code) => {
        run.exitCode = code;
        resolve(code);
      }),
    );
    /** Waits for `assertion` to hold while the CLI runs; a CLI that exits first fails the test at once. */
    const until = (assertion: () => void) =>
      vi.waitFor(() => {
        if (run.exitCode !== undefined) {
          throw new Error(`The CLI exited (${run.exitCode}) first. It said:\n${run.stdout}\n${run.stderr}`);
        }
        assertion();
      }, 20_000);
    const answering = () => until(() => expect(run.stdout).toContain(`Answering in ${DM} as ${CLAUDE}, from `));
    return { run, exited, until, answering, pid: child.pid! };
  };

  /** What the assistant's account sent, in order. */
  const sent = () =>
    assistant.requests
      .filter((r) => r.method === 'POST' && r.path === `/v1/chats/${DM}/messages`)
      .map((r) => (r.body as { text: string }).text);

  const auditText = async (auditDir: string) => {
    const files = (await readdir(auditDir)).filter((f) => f.startsWith('audit-'));
    return (await Promise.all(files.map((f) => readFile(join(auditDir, f), 'utf8')))).join('');
  };
  const entries = (text: string) =>
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string; stage?: string; context?: Record<string, unknown> });

  /** A message the owner writes, as their Beeper gives it. */
  const fromOwner = (overrides: Partial<WireMessage>) =>
    wireMessage({ isSender: true, senderID: OWNER, senderName: 'Owner', timestamp: new Date().toISOString(), ...overrides });

  beforeEach(async () => {
    owner = new MockBeeperServer();
    ownerUrl = await owner.start();
    owner.self = { id: OWNER, fullName: 'Owner' };
    owner.accounts = [
      { accountID: 'matrix', network: 'Beeper' },
      { accountID: 'whatsapp-1', network: 'WhatsApp' },
    ];
    owner.chats = [
      wireChat({
        id: DM,
        accountID: 'matrix',
        network: 'Beeper',
        title: 'Claude',
        participants: { items: [{ id: OWNER, isSelf: true }, { id: CLAUDE, fullName: 'Claude' }], hasMore: false, total: 2 },
      }),
      wireChat({
        id: FAMILY,
        accountID: 'whatsapp-1',
        network: 'WhatsApp',
        type: 'group',
        title: 'Family',
        participants: {
          items: [{ id: OWNER, isSelf: true }, { id: 'alice', fullName: 'Alice' }, { id: 'bob', fullName: 'Bob' }],
          hasMore: false,
          total: 3,
        },
      }),
    ];
    owner.messages = [
      wireMessage({ id: 'alice-1', chatID: FAMILY, text: "Dinner at Bob's tonight?", timestamp: new Date(Date.now() - 60_000).toISOString() }),
    ];

    assistant = new MockBeeperServer();
    assistantUrl = await assistant.start();
    assistant.self = { id: CLAUDE, fullName: 'Claude' };
    assistant.accounts = [{ accountID: 'matrix', network: 'Beeper' }];
    assistant.chats = [
      wireChat({
        id: DM,
        accountID: 'matrix',
        network: 'Beeper',
        title: 'Owner',
        participants: { items: [{ id: CLAUDE, isSelf: true }, { id: OWNER, fullName: 'Owner' }], hasMore: false, total: 2 },
      }),
    ];

    dir = await mkdtemp(join(tmpdir(), 'claude-messenger-respond-'));
    assistantDir = join(dir, 'assistant');
    await mkdir(assistantDir);
    await writeFile(join(assistantDir, '.env'), `BEEPER_ACCESS_TOKEN=${assistant.token}\nBEEPER_BASE_URL=${assistantUrl}\n`);
    await writeFile(
      join(assistantDir, 'policy.json'),
      JSON.stringify({ version: 1, capabilities: { read: true, send: true }, send: { chatAllowlist: [DM], maxMessagesPerHour: 30 } }),
    );
    claude = await writeClaudeShim({ stdout: `${ANSWER}\n` });
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    child = undefined;
    await owner.stop();
    await assistant.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers an @Claude anywhere and what the owner writes in its chat, there alone, until SIGTERM, keeping what was said out of every log', async () => {
    const cli = start();
    await cli.answering();

    owner.messages.push(fromOwner({ id: 'ask-1', chatID: FAMILY, text: '@Claude when is dinner?' }));
    await cli.until(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatch(new RegExp(`^In "Family", ${TIME}:\\n\\n${escape(SHOWN)}$`));

    // The model read the chat through the owner's Beeper: what came before, then the request.
    const [call] = await claude.calls();
    expect(call!.stdin.split('\n').slice(-6)).toEqual([
      '## "Family"',
      'WhatsApp · group of 3',
      expect.stringMatching(new RegExp(`^- ${TIME} "Alice": Dinner at Bob's tonight\\?$`)),
      '',
      "## The owner's message to you",
      expect.stringMatching(new RegExp(`^- ${TIME} The owner: ＠Claude when is dinner\\?$`)),
    ]);
    expect(call!.argv).toContain('sonnet');

    owner.messages.push(fromOwner({ id: 'ask-2', chatID: DM, accountID: 'matrix', text: 'and dessert?' }));
    await cli.until(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toBe(SHOWN);

    process.kill(cli.pid, 'SIGTERM');
    expect(await cli.exited).toBe(0);
    expect(cli.run.stdout.trim().split('\n').slice(1)).toEqual([`${FAMILY} ask-1: answered`, `${DM} ask-2: answered`, 'Stopped.']);

    // Nothing anyone wrote, nor the answers, is in the journal or either audit log.
    const ownerAudit = await auditText(join(dir, 'audit'));
    const assistantAudit = await auditText(join(assistantDir, 'audit'));
    for (const text of [cli.run.stdout, cli.run.stderr, ownerAudit, assistantAudit]) {
      expect(text).not.toMatch(/dinner|dessert|directions/i);
    }
    // The owner's audit names what was read for each request; the assistant's, what it sent, by length.
    expect(entries(ownerAudit).filter((e) => e.action === 'getMessage').map((e) => e.context)).toEqual([
      { chatId: FAMILY, messageId: 'ask-1' },
      { chatId: DM, messageId: 'ask-2' },
    ]);
    expect(entries(assistantAudit).filter((e) => e.action === 'sendMessage' && e.stage === 'intent').map((e) => e.context)).toEqual([
      { chatId: DM, textLength: sent()[0]!.length },
      { chatId: DM, textLength: SHOWN.length },
    ]);

    // Where it got to is kept, by IDs and times alone, readable by the owner alone.
    const checkpoint = join(assistantDir, 'state', 'responder.json');
    expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      version: 1,
      handled: [
        { chatId: FAMILY, messageId: 'ask-1' },
        { chatId: DM, messageId: 'ask-2' },
      ],
    });
  });

  it('answers what was asked while it was stopped when it starts again, and nothing twice', async () => {
    const first = start();
    await first.answering();
    owner.messages.push(fromOwner({ id: 'ask-1', chatID: FAMILY, text: '@Claude one' }));
    await first.until(() => expect(sent()).toHaveLength(1));
    process.kill(first.pid, 'SIGTERM');
    expect(await first.exited).toBe(0);

    owner.messages.push(fromOwner({ id: 'ask-2', chatID: FAMILY, text: '@Claude two' }));
    const second = start();
    await second.until(() => expect(sent()).toHaveLength(2));
    process.kill(second.pid, 'SIGTERM');
    expect(await second.exited).toBe(0);

    expect(second.run.stdout).toContain(`${FAMILY} ask-1: skipped, already handled`);
    expect(second.run.stdout).toContain(`${FAMILY} ask-2: answered`);
    expect((await claude.calls()).map((c) => c.stdin.split('\n').at(-1))).toEqual([
      expect.stringMatching(/The owner: ＠Claude one$/),
      expect.stringMatching(/The owner: ＠Claude two$/),
    ]);
  });

  it("tells the owner when the model can't answer, and journals only the kind of failure", async () => {
    const failing = await writeClaudeShim({ exitCode: 1, stderr: 'API Error: usage limit reached; you asked "when is dinner"\n' });
    const cli = start(failing);
    await cli.answering();
    owner.messages.push(fromOwner({ id: 'ask-1', chatID: FAMILY, text: '@Claude when is dinner?' }));
    await cli.until(() => expect(sent()).toHaveLength(1));
    process.kill(cli.pid, 'SIGTERM');
    expect(await cli.exited).toBe(0);

    expect(sent()[0]).toMatch(new RegExp(`^Sorry, I couldn't answer your message from ${TIME}\\. Please ask me again later\\.$`));
    expect(cli.run.stdout).toContain(`${FAMILY} ask-1: not answered (model_failed); told the owner`);
    expect(cli.run.stdout + cli.run.stderr).not.toMatch(/usage limit|dinner/);
  });

  it("stops on a failure that isn't one request's, giving only its kind, since its text can quote a message", async () => {
    const cli = start();
    await cli.answering();
    owner.forcedError = { status: 500, message: 'while reading "when is dinner?"' };
    expect(await cli.exited).toBe(1);

    expect(cli.run.stderr.trim()).toBe('✗ [provider_error] Stopped answering.');
    expect(sent()).toEqual([]);
  });

  it("refuses to start without its chat with the owner, saying how to open it, sending nothing", async () => {
    assistant.chats = [];
    const cli = start();
    expect(await cli.exited).toBe(1);

    expect(cli.run.stderr).toContain("The assistant has no direct chat with the owner yet. Open one, from the assistant's directory, with: claude-messenger start-chat --with");
    expect(sent()).toEqual([]);
    expect(await claude.calls()).toEqual([]);
  });

  it("says how to start over when its checkpoint can't be read, rather than guess where to resume", async () => {
    const checkpoint = join(assistantDir, 'state', 'responder.json');
    await mkdir(join(assistantDir, 'state'));
    await writeFile(checkpoint, '{"version": 1, "since": ');
    const cli = start();
    expect(await cli.exited).toBe(1);

    expect(cli.run.stderr.trim()).toBe(
      `✗ [checkpoint_unreadable] ${checkpoint} is not a checkpoint this version can read. ` +
        'Delete it to start answering from now, leaving any request made while it was stopped unanswered.',
    );
    expect(sent()).toEqual([]);
  });

  it('stops, saying why, when it cannot count what it sends, rather than send uncounted', async () => {
    // Something that isn't a file where the assistant's sends are counted.
    const window = join(assistantDir, 'state', 'send-window.jsonl');
    await mkdir(window, { recursive: true });
    const cli = start();
    await cli.answering();
    owner.messages.push(fromOwner({ id: 'ask-1', chatID: FAMILY, text: '@Claude when is dinner?' }));
    expect(await cli.exited).toBe(1);

    expect(cli.run.stderr.trim()).toBe(
      `✗ [rate_window_unavailable] Cannot read rate-limit state at ${window}; refusing to send without it.`,
    );
    expect(sent()).toEqual([]);
  });

  it("never answers with the owner's token when the assistant's .env has none", async () => {
    await writeFile(join(assistantDir, '.env'), `BEEPER_BASE_URL=${assistantUrl}\n`);
    const cli = start();
    expect(await cli.exited).toBe(1);

    expect(cli.run.stderr).toContain(`${join(assistantDir, '.env')}: Invalid configuration — BEEPER_ACCESS_TOKEN`);
    expect(assistant.requests).toEqual([]);
  });
});

/** `text` as a regular expression that matches it alone. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
