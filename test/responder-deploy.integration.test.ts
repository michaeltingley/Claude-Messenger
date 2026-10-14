import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost, type ScriptResult } from './fake-host.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

/**
 * deploy/responder.sh runs `claude-messenger respond` as the system unit
 * claude-messenger-responder.service, and signs in the Claude Code that
 * writes its answers. It runs here as a real subprocess, the way a Claude
 * session runs it (no terminal, and nothing on stdin but a code), on a fake
 * host (test/fake-host.ts) whose systemd really starts the built CLI, between
 * two mock Beepers: the owner's, and the assistant's own.
 *
 * Claude Code is the fake host's. Its sign-in screen is drawn as the real
 * one draws its screens (test/claude-sign-in-screen.mjs), since only a person
 * can approve the real one; against the real one, the script was run as far
 * as its link and its refusal of a wrong code. The unit's sandbox under the
 * real systemd, with the real Claude Code answering in it, is proven in
 * test/responder-sandbox.integration.test.ts.
 */

const REPO = join(import.meta.dirname, '..');
const UNIT = 'claude-messenger-responder.service';
const OWNER = '@owner:beeper.local';
const CLAUDE = '@claude:beeper.local';
const DM = '!dm:beeper.local';
const FAMILY = '!family:beeper.local';
const TOKEN = 'sk-ant-oat01-Resp0nder_Test-Token-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ-KLMNOPAA';
/** The code the sign-in screen takes, unless a test says otherwise. */
const CODE = 'stand-in-code#stand-in-state';

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

// A run that starts the responder waits for the built CLI to start answering.
describe('deploy/responder.sh (subprocess, no terminal, fake host)', { timeout: 60_000 }, () => {
  let host: FakeHost;
  let owner: MockBeeperServer;
  let assistant: MockBeeperServer;
  let install: string;
  let assistantDir: string;

  beforeEach(async () => {
    host = new FakeHost();

    owner = new MockBeeperServer();
    const ownerUrl = await owner.start();
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
      wireChat({ id: FAMILY, accountID: 'whatsapp-1', network: 'WhatsApp', type: 'group', title: 'Family' }),
    ];
    assistant = new MockBeeperServer();
    const assistantUrl = await assistant.start();
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

    // A checkout, as bootstrap and configure.sh leave it: the repo's deploy/,
    // a built dist/, and a .env with the owner's Beeper token.
    install = join(host.root, 'claude-messenger');
    mkdirSync(install);
    symlinkSync(join(REPO, 'deploy'), join(install, 'deploy'));
    symlinkSync(join(build, 'dist'), join(install, 'dist'));
    writeFileSync(
      join(install, '.env'),
      `BEEPER_BASE_URL=${ownerUrl}\nBEEPER_ACCESS_TOKEN=${owner.token}\nBEEPER_POLL_INTERVAL_MS=1000\n`,
      { mode: 0o600 },
    );
    // The assistant's configuration, as deploy/assistant-beeper.sh and its sign-up leave it, with a policy that lets it answer.
    assistantDir = join(host.home, '.config', 'claude-messenger', 'assistant');
    mkdirSync(assistantDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(assistantDir, '.env'), `BEEPER_BASE_URL=${assistantUrl}\nBEEPER_ACCESS_TOKEN=${assistant.token}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      join(assistantDir, 'policy.json'),
      JSON.stringify({ version: 1, capabilities: { read: true, send: true }, send: { chatAllowlist: [DM], maxMessagesPerHour: 30 } }),
    );
  });

  afterEach(async () => {
    host.dispose();
    await owner.stop();
    await assistant.stop();
  });

  const script = () => join(install, 'deploy', 'responder.sh');
  const run = (args: string[] = [], extra: Record<string, string> = {}) => host.runDetached('bash', [script(), ...args], extra);
  /** `sign-in finish`, given `code` on stdin as a session gives it. */
  const finish = (code: string, extra: Record<string, string> = {}) =>
    host.runDetached('bash', ['-c', 'printf "%s\\n" "$CODE" | bash "$0" sign-in finish', script()], { CODE: code, ...extra });
  /** A failing run's message: what it printed, and what the units it started printed. */
  const why = (result: ScriptResult) => `${result.stdout}\n${result.stderr}\n${host.logs()}`;

  const tokenFile = () => join(assistantDir, 'claude-code.env');
  const signInDir = () => join(assistantDir, 'claude-sign-in');
  const claudeConfig = () => join(assistantDir, 'state', 'claude-code');
  const installedUnit = () => join(host.systemUnitDir, UNIT);
  const checkpoint = () => join(assistantDir, 'state', 'responder.json');
  /** The Claude Code the fake host has on PATH. */
  const claude = () => join(host.root, 'bin', 'claude');
  /** Commands run as root since `from` calls into the log. */
  const rootCalls = (from = 0) => host.calls().slice(from).filter((call) => call.startsWith('sudo '));
  /** Every process still running from this host's Claude Code sign-in. */
  const signInsRunning = () =>
    readdirSync('/proc')
      .filter((pid) => /^\d+$/.test(pid))
      .filter((pid) => {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
          return cmdline.includes(host.root) && (cmdline.includes('setup-token') || cmdline.includes('claude-sign-in-screen'));
        } catch {
          return false;
        }
      });
  /** What the model runs Claude Code was given to sign in with, one line each. */
  const modelRuns = () => (host.has('claude-runs.log') ? host.read('claude-runs.log').split('\n').filter(Boolean) : []);
  /** What the fake systemd started, as the CLI's stdout shows it. */
  const serviceLog = () => (existsSync(join(host.state, 'logs', `${UNIT}.log`)) ? host.read(join('logs', `${UNIT}.log`)) : '');
  /** What a sign-in saves, as if one had run. */
  const signedIn = () => writeFileSync(tokenFile(), `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  /** Nothing of the service anywhere: no unit, and nothing done as root but asking for sudo. */
  const expectNothingInstalled = () => {
    expect(existsSync(installedUnit()), 'the unit').toBe(false);
    expect(rootCalls().filter((call) => call !== 'sudo -n true')).toEqual([]);
  };

  describe('sign-in', () => {
    it('signs Claude Code in for the service with a token that can only write answers, saved owner-only and never displayed', async () => {
      host.set('setup-token-token', TOKEN);

      const started = await run(['sign-in', 'start']);

      expect(started.code, why(started)).toBe(0);
      // The link Claude Code showed, whole, though its text wrapped on screen.
      const [link] = started.stdout.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/) ?? [];
      expect(new URL(link!).searchParams.get('scope')).toBe('user:inference');
      expect(started.stdout).toContain("printf '%s\\n' '<the code>' | responder.sh sign-in finish");
      // It waits for the code, holding the half of the sign-in that redeems it.
      expect(signInsRunning()).not.toEqual([]);
      expect(statSync(signInDir()).mode & 0o777).toBe(0o700);

      const finished = await finish(CODE);

      expect(finished.code, why(finished)).toBe(0);
      expect(host.read('setup-token-received')).toBe(CODE);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
      expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
      expect(finished.stdout).toContain(`Its token is in ${tokenFile()}; it was never displayed.`);
      for (const output of [started.stdout, started.stderr, finished.stdout, finished.stderr]) {
        expect(output).not.toContain(TOKEN.slice('sk-ant-oat01-'.length));
      }
      // Checked as the service will run it: with this token, in the service's own configuration.
      expect(finished.stdout).toContain('Claude Code answers with it');
      expect(modelRuns()).toEqual([`token=${TOKEN} config=${claudeConfig()}`]);
      expect(statSync(claudeConfig()).mode & 0o777).toBe(0o700);
      // Nothing of the sign-in is left: not its screen, which showed the token, nor its process.
      expect(existsSync(signInDir())).toBe(false);
      expect(signInsRunning()).toEqual([]);
    });

    it('takes the token when Claude Code ends as it shows it', async () => {
      host.set('setup-token-token', TOKEN).set('setup-token-exits');
      expect((await run(['sign-in', 'start'])).code).toBe(0);

      const finished = await finish(CODE);

      expect(finished.code, why(finished)).toBe(0);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    });

    it('keeps waiting for the code after a blank or garbled one, which never reaches Claude Code', async () => {
      host.set('setup-token-token', TOKEN);
      expect((await run(['sign-in', 'start'])).code).toBe(0);

      const blank = await finish('');
      // An escape would be a keypress on Claude Code's screen.
      const garbled = await finish(`${CODE}\u001b[A`);

      expect(blank.code).toBe(1);
      expect(blank.stderr).toContain('No code on stdin.');
      expect(garbled.code).toBe(1);
      expect(garbled.stderr).toContain("That is not a code Claude Code's sign-in page shows; the sign-in still waits for one.");
      expect(host.has('setup-token-received')).toBe(false);
      const finished = await finish(CODE);
      expect(finished.code, why(finished)).toBe(0);
      expect(existsSync(tokenFile())).toBe(true);
    });

    it('says a wrong code failed, in Claude Code’s words, saving nothing and leaving nothing waiting', async () => {
      expect((await run(['sign-in', 'start'])).code).toBe(0);

      const finished = await finish('another-code#stand-in-state');

      expect(finished.code).toBe(1);
      expect(finished.stderr).toContain(
        "Claude Code's sign-in failed: OAuth error: Request failed with status code 400. Nothing was saved; start again: responder.sh sign-in start",
      );
      expect(existsSync(tokenFile())).toBe(false);
      expect(existsSync(signInDir())).toBe(false);
      expect(signInsRunning()).toEqual([]);
    });

    it('keeps the token, but says so, when Claude Code cannot answer with it', async () => {
      host.set('setup-token-token', TOKEN).set('claude-refuses');
      expect((await run(['sign-in', 'start'])).code).toBe(0);

      const finished = await finish(CODE);

      expect(finished.code).toBe(1);
      expect(finished.stderr).toContain(
        'Claude Code could not answer with the new token: Claude Code failed (exit 1): Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      );
      expect(finished.stderr).toContain(`The token is kept in ${tokenFile()}: once Claude Code answers, responder.sh starts the responder with it.`);
      expect(readFileSync(tokenFile(), 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    });

    it('refuses a link that asks for more than writing answers, leaving nothing waiting', async () => {
      host.set('setup-token-scope', 'user:inference user:mcp_servers');

      const started = await run(['sign-in', 'start']);

      expect(started.code).toBe(1);
      expect(started.stderr).toContain(
        "Claude Code's sign-in link was refused: it asks for user:inference user:mcp_servers, not user:inference alone. Nothing was signed in.",
      );
      expect(started.stdout).not.toContain('https://');
      expect(existsSync(signInDir())).toBe(false);
      expect(signInsRunning()).toEqual([]);
    });

    it('says what Claude Code said when it fails before showing a link', async () => {
      host.set('setup-token-says', 'Unable to reach claude.ai');

      const started = await run(['sign-in', 'start']);

      expect(started.code).toBe(1);
      expect(started.stderr).toContain('Claude Code showed no sign-in link. It said:\n    Unable to reach claude.ai');
      expect(existsSync(signInDir())).toBe(false);
    });

    it('replaces a sign-in already waiting, whose link is then not the one to use', async () => {
      host.set('setup-token-token', TOKEN);
      expect((await run(['sign-in', 'start'])).code).toBe(0);
      const first = signInsRunning();

      expect((await run(['sign-in', 'start'])).code).toBe(0);

      expect(signInsRunning()).not.toEqual(expect.arrayContaining(first));
      expect((await finish(CODE)).code).toBe(0);
    });

    it('says to start one when no sign-in is waiting', async () => {
      const finished = await finish(CODE);

      expect(finished.code).toBe(1);
      expect(finished.stderr).toContain('No sign-in is waiting');
      expect(finished.stderr).toContain('Start one: responder.sh sign-in start');
    });

    it('needs the assistant’s configuration, where the token goes', async () => {
      rmSync(assistantDir, { recursive: true });

      const started = await run(['sign-in', 'start']);

      expect(started.code).toBe(1);
      expect(started.stderr).toContain(`${assistantDir} does not exist. Make the assistant's configuration first`);
      expect(signInsRunning()).toEqual([]);
    });
  });

  describe('the service', () => {
    it('installs it as a system unit that starts at boot, filled in for this host, and waits until it answers', async () => {
      signedIn();
      const node = process.execPath;

      const result = await run([], { RESPONDER_TIME_ZONE: 'America/Los_Angeles' });

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain(`${UNIT}: answering @Claude from the assistant's account, with times in America/Los_Angeles`);
      const unit = readFileSync(installedUnit(), 'utf8');
      expect(unit).not.toContain('__');
      expect(unit).toContain(`User=${FakeHost.USER}\n`);
      expect(unit).toContain(
        `ExecStart=${node} dist/cli/main.js respond --assistant ${assistantDir} --time-zone America/Los_Angeles\n`,
      );
      expect(unit).toContain(`Environment=PATH=${join(host.root, 'bin')}:/usr/local/bin:/usr/bin:/bin\n`);
      expect(unit).toContain(`Environment=CLAUDE_CONFIG_DIR=${claudeConfig()}\n`);
      expect(unit).toContain(`EnvironmentFile=${tokenFile()}\n`);
      expect(unit).toContain(`BindReadOnlyPaths=${install} ${node} ${assistantDir} ${claude()}\n`);
      expect(unit).toContain(
        `BindPaths=${install}/audit ${install}/state ${assistantDir}/audit ${assistantDir}/state\n`,
      );
      expect(host.has(`system/enabled/${UNIT}`)).toBe(true);
      // Started by systemd, the built CLI found the assistant's chat with the owner, and saved where it got to.
      expect(serviceLog()).toContain(`Answering in ${DM} as ${CLAUDE}, from `);
      expect(existsSync(checkpoint())).toBe(true);
    });

    it('answers @Claude through what it installed, with the token Claude Code was signed in with', async () => {
      signedIn();
      host.set('claude-answer', 'Dinner is at 8.');
      expect((await run()).code).toBe(0);

      owner.messages.push(
        wireMessage({
          id: 'ask-1',
          chatID: FAMILY,
          accountID: 'whatsapp-1',
          isSender: true,
          senderID: OWNER,
          text: '@Claude when is dinner?',
          timestamp: new Date().toISOString(),
        }),
      );
      const sent = () =>
        assistant.requests.filter((r) => r.method === 'POST' && r.path === `/v1/chats/${DM}/messages`).map((r) => (r.body as { text: string }).text);
      for (const end = Date.now() + 20_000; sent().length === 0; await sleep(50)) {
        if (Date.now() > end) throw new Error(`no answer was sent:\n${host.logs()}`);
      }

      expect(sent()).toEqual([expect.stringMatching(/^In "Family", .*\n\nDinner is at 8\.$/)]);
      expect(modelRuns()).toEqual([`token=${TOKEN} config=${claudeConfig()}`]);
    });

    it('keeps the time zone it gives times in when run again without one, restarting onto the new code', async () => {
      signedIn();
      expect((await run([], { RESPONDER_TIME_ZONE: 'America/Los_Angeles' })).code).toBe(0);
      const first = host.read(`system/pids/${UNIT}`);

      const again = await run();

      expect(again.code, why(again)).toBe(0);
      expect(again.stdout).toContain('with times in America/Los_Angeles');
      expect(readFileSync(installedUnit(), 'utf8')).toContain('--time-zone America/Los_Angeles\n');
      expect(host.read(`system/pids/${UNIT}`)).not.toBe(first);
    });

    it('gives times in this host’s zone when none is given, and says how to change it', async () => {
      signedIn();
      const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(readFileSync(installedUnit(), 'utf8')).toContain(`--time-zone ${hostZone}\n`);
      expect(result.stdout).toContain('To give times in another zone: RESPONDER_TIME_ZONE=<zone> responder.sh');
    });

    it('warns that the responder gets no process namespace of its own on systemd older than 257, and installs anyway', async () => {
      signedIn();
      host.set('systemd-version', '255');

      const result = await run();

      expect(result.code, why(result)).toBe(0);
      expect(result.stdout).toContain('systemd 255 is older than 257, so the responder cannot get its own process namespace');
      expect(host.has(`system/enabled/${UNIT}`)).toBe(true);
    });

    it('fails, pointing at the journal, when the responder does not start answering', async () => {
      signedIn();
      await assistant.stop();
      const started = Date.now();

      const result = await run();

      expect(result.code, why(result)).toBe(1);
      expect(result.stderr).toContain(`the responder did not start answering. Check: sudo journalctl -u ${UNIT}`);
      // It saw the responder stop, rather than waiting out its minute.
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  });

  describe('what it refuses before changing anything', () => {
    it('refuses until Claude Code is signed in for the service', async () => {
      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `Claude Code is not signed in for the responder (no token in ${tokenFile()}). Sign it in: responder.sh sign-in start`,
      );
      expectNothingInstalled();
    });

    it('refuses until the owner’s Beeper is connected', async () => {
      signedIn();
      writeFileSync(join(install, '.env'), 'BEEPER_BASE_URL=http://127.0.0.1:9\n');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${install}/.env has no Beeper token, so the responder can't read your messages.`);
      expectNothingInstalled();
    });

    it('refuses until the assistant has its own Beeper account here', async () => {
      signedIn();
      writeFileSync(join(assistantDir, '.env'), 'BEEPER_BASE_URL=http://127.0.0.1:9\n');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`the assistant has no Beeper account here yet (no token in ${assistantDir}/.env).`);
      expectNothingInstalled();
    });

    it.each([
      ['the owner’s policy', () => [join(install, '.env'), 'CLAUDE_MESSENGER_POLICY=/etc/claude-messenger/policy.json'] as const],
      ['the assistant’s audit trail', () => [join(assistantDir, '.env'), 'CLAUDE_MESSENGER_AUDIT_DIR=../audit'] as const],
    ])('refuses a .env that keeps %s where the sandbox hides it', async (_, where) => {
      signedIn();
      const [file, line] = where();
      writeFileSync(file, `${readFileSync(file, 'utf8')}${line}\n`);

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`and ${file} puts some elsewhere:\n    ${line}, not `);
      expectNothingInstalled();
    });

    it('refuses a time zone that is not one', async () => {
      signedIn();

      const result = await run([], { RESPONDER_TIME_ZONE: 'Mars/Olympus_Mons' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "RESPONDER_TIME_ZONE must be an IANA time zone, such as America/Los_Angeles, not 'Mars/Olympus_Mons'.",
      );
      expectNothingInstalled();
    });

    it('refuses to run as root', async () => {
      signedIn();
      host.set('root');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Run as the user who owns this install, not root.');
      expectNothingInstalled();
    });

    it('says it needs sudo, instead of hanging, when nobody can type sudo’s password', async () => {
      signedIn();
      host.set('sudo-needs-password');

      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('this needs sudo, which it could not get');
      expect(existsSync(installedUnit())).toBe(false);
    });

    it.each([['--force'], ['sign-in'], ['sign-in', 'begin']])('rejects %j with its usage', async (...args) => {
      const result = await run(args);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('usage: responder.sh [sign-in start | sign-in finish]');
      expectNothingInstalled();
    });
  });
});
