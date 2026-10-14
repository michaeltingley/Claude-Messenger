import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBeeperServer, wireChat } from './mock-beeper.js';

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, '..');

/** An address of the owner's, as the sign-up gets one. */
const EMAIL = 'owner+claude@example.com';

/** The chat every Beeper account has on Beeper's own network, which is no chat network of the kind a reset endangers. */
const beeperOwnChat = () =>
  wireChat({ id: '!support:beeper.local', accountID: 'matrix', network: 'matrix', title: 'Beeper Support' });

/**
 * `signup` creates the assistant's own Beeper account, on the runtime
 * deploy/assistant-beeper.sh installs. These tests run the real CLI as a
 * subprocess, from a scratch directory whose .env names the endpoint as that
 * script writes it, against the mock's model of Beeper Server's setup API;
 * the mock's inbox stands in for the owner's mail, where the code is read.
 *
 * Besides the account, they check what the command must never do: print the
 * new token or a recovery key, sign up from an endpoint signed in already,
 * stay signed in to an account the address already had, or set up afresh the
 * encryption of an account that had some, or that has chat networks.
 */
describe('signup (subprocess integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let dir: string;
  let envFile: string;

  /** The CLI in `dir`. The .env there names the endpoint and holds the token, as on the host, unless `env` does. */
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_MESSENGER_POLICY: join(dir, 'policy.json'),
      CLAUDE_MESSENGER_AUDIT_DIR: join(dir, 'audit'),
      CLAUDE_MESSENGER_STATE_DIR: join(dir, 'state'),
    };
    delete childEnv.BEEPER_BASE_URL;
    delete childEnv.BEEPER_ACCESS_TOKEN;
    Object.assign(childEnv, env);
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

  /** `signup start`, then the request ID it printed and the code that reached the inbox. */
  const start = async (env: Record<string, string> = {}) => {
    const started = await cli(['signup', 'start', '--email', EMAIL], env);
    expect(started.code, started.stderr).toBe(0);
    const request = /--request (\S+) --code <code>/.exec(started.stdout)?.[1];
    expect(request).toBeDefined();
    const emailed = mock.emailedCodes.at(-1);
    expect(emailed?.email).toBe(EMAIL);
    return { started, request: request!, code: emailed!.code };
  };

  const finish = (request: string, code: string, more: string[], env: Record<string, string> = {}) =>
    cli(['signup', 'finish', '--request', request, '--code', code, ...more], env);

  const posted = (path: string) => mock.requests.filter((r) => r.method === 'POST' && r.path === path);
  const RESET = '/v1/app/setup/verification/recovery-key/reset';
  const CONFIRM = `${RESET}/confirm`;

  /** Everything in the scratch directory, as text: where a key must not have landed. */
  const everythingWritten = async () => {
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    const texts = await Promise.all(
      files.filter((f) => f.isFile()).map((f) => readFile(join(f.parentPath, f.name), 'utf8')),
    );
    return texts.join('\n');
  };

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    // A fresh runtime: signed out, as deploy/assistant-beeper.sh starts it.
    mock.signedIn = false;
    mock.chats = [beeperOwnChat()];
    dir = await mkdtemp(join(tmpdir(), 'claude-messenger-signup-'));
    envFile = join(dir, '.env');
    await writeFile(envFile, `BEEPER_BASE_URL=${baseUrl}\n`, { mode: 0o600 });
  });

  afterEach(async () => {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the account from the emailed code, saves its token owner-only unprinted, and waits while Beeper sets up its encryption', async () => {
    const { started, request, code } = await start();
    expect(started.stdout).toContain(`✓ Beeper emailed a sign-up code to ${EMAIL}.`);

    const { stdout, stderr, code: exit } = await finish(request, code, ['--username', 'claude', '--accept-terms']);

    expect(exit, stderr).toBe(0);
    expect(mock.createdAccounts).toHaveLength(1);
    const [account] = mock.createdAccounts;
    expect(account).toMatchObject({ email: EMAIL, username: 'claude', userID: '@claude:beeper.local' });
    expect(posted('/v1/app/setup/register')[0]?.body).toMatchObject({ username: 'claude', acceptTerms: true });
    expect(stdout).toContain('✓ Created the Beeper account @claude:beeper.local.');
    expect(stdout).toMatch(
      /Beeper is setting up the account's encryption\.\.\.\n✓ The account is ready, its encryption set up\./,
    );

    // The token went straight to the file, owner-only, and nowhere else.
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\nBEEPER_ACCESS_TOKEN=${account!.accessToken}\n`);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(stdout + stderr).not.toContain(account!.accessToken);

    // Beeper's own setup needed nothing more: no key was made here.
    expect(posted(RESET)).toEqual([]);

    // The saved token is the working credential: setup is done, so a re-run does nothing.
    const again = await cli(['signup', 'encrypt']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('✓ The account is ready');
    expect(posted(RESET)).toEqual([]);
  }, 60_000);

  it('sets up afresh the encryption of a new account Beeper leaves without any, with a key it neither shows nor keeps', async () => {
    mock.newAccountState = 'needs-cross-signing-setup';
    const { request, code } = await start();

    const { stdout, stderr, code: exit } = await finish(request, code, ['--accept-terms']);

    expect(exit, stderr).toBe(0);
    expect(stdout).toMatch(/Setting up encryption\.\.\.\n✓ The account is ready, its encryption set up\./);

    // Encryption was set up afresh once, with Beeper's own network no bar to
    // it, and its recovery key was used without being shown or kept.
    expect(mock.recoveryKeys).toHaveLength(1);
    const [{ key, confirmed }] = mock.recoveryKeys as [{ key: string; confirmed: boolean }];
    expect(confirmed).toBe(true);
    expect(stdout + stderr).not.toContain(key);
    expect(await everythingWritten()).not.toContain(key);

    // Done is done: a re-run makes no second key.
    const again = await cli(['signup', 'encrypt']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('✓ The account is ready');
    expect(posted(RESET)).toHaveLength(1);
  }, 60_000);

  it("takes Beeper's suggested username when none is given", async () => {
    const { request, code } = await start();

    const { stderr, code: exit } = await finish(request, code, ['--accept-terms']);

    expect(exit, stderr).toBe(0);
    expect(mock.createdAccounts.map((a) => a.username)).toEqual(['claude-1a2b']);
  }, 60_000);

  it('waits through Beeper syncing the new account for the first time', async () => {
    mock.firstSyncPolls = 2;
    const { request, code } = await start();

    const { stdout, stderr, code: exit } = await finish(request, code, ['--accept-terms']);

    expect(exit, stderr).toBe(0);
    expect(stdout).toMatch(/Beeper is syncing the account for the first time\.\.\.\n✓ The account is ready/);
  }, 60_000);

  it('emails nothing when the endpoint is signed in to an account already', async () => {
    mock.signedIn = true;

    const { stderr, code } = await cli(['signup', 'start', '--email', EMAIL]);

    expect(code).toBe(1);
    expect(stderr).toContain('is signed in to an account already');
    expect(stderr).toContain('nothing was emailed');
    expect(posted('/v1/app/setup/start')).toEqual([]);
    expect(mock.emailedCodes).toEqual([]);
  }, 60_000);

  it('contacts Beeper about nothing given an address that is not one', async () => {
    const { stderr, code } = await cli(['signup', 'start', '--email', 'claude']);

    expect(code).toBe(1);
    expect(stderr).toContain('must be an email address');
    expect(mock.requests).toEqual([]);
  }, 60_000);

  it('sends nothing to Beeper without --accept-terms, so the code still works once they are accepted', async () => {
    const { request, code } = await start();
    const before = mock.requests.length;

    const refused = await finish(request, code, []);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('https://www.beeper.com/terms-onboarding');
    expect(refused.stderr).toContain('Nothing was sent to Beeper.');
    expect(mock.requests).toHaveLength(before);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\n`);

    const accepted = await finish(request, code, ['--accept-terms']);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(mock.createdAccounts).toHaveLength(1);
  }, 60_000);

  it('signs straight back out of an account the address already had, keeping nothing of it', async () => {
    mock.existingAccounts.add(EMAIL);
    const { request, code } = await start();

    const { stdout, stderr, code: exit } = await finish(request, code, ['--accept-terms']);

    expect(exit).toBe(1);
    expect(stderr).toContain('already has a Beeper account, so nothing was created');
    expect(stderr).toContain('it was signed out again at once');
    expect(stderr).toContain('deploy/assistant-beeper.sh --reset');
    expect(mock.signedOutTokens).toHaveLength(1);
    expect(stdout + stderr).not.toContain(mock.signedOutTokens[0]);
    expect(mock.createdAccounts).toEqual([]);
    expect(posted('/v1/app/setup/register')).toEqual([]);
    expect(posted(RESET)).toEqual([]);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\n`);
  }, 60_000);

  it('names the device to remove when it cannot sign out of an account the address already had', async () => {
    mock.existingAccounts.add(EMAIL);
    mock.failSetup = (path) => (path === '/_matrix/client/v3/logout' ? { status: 500, message: 'down' } : undefined);
    const { request, code } = await start();

    const { stderr, code: exit } = await finish(request, code, ['--accept-terms']);

    expect(exit).toBe(1);
    expect(stderr).toMatch(/signing it out failed: remove the device DEV[0-9A-F]{8} from that account in Beeper/);
    expect(mock.signedOutTokens).toEqual([]);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\n`);
  }, 60_000);

  it('saves nothing when the code is wrong, quoting why', async () => {
    const { request } = await start();

    const { stderr, code } = await finish(request, '000000', ['--accept-terms']);

    expect(code).toBe(1);
    expect(stderr).toContain('Beeper could not accept the code (HTTP 400): That code is not right, or has expired');
    expect(mock.createdAccounts).toEqual([]);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\n`);
  }, 60_000);

  it('saves nothing when the username is taken, quoting why', async () => {
    mock.takenUsernames.add('claude');
    const { request, code } = await start();

    const { stderr, code: exit } = await finish(request, code, ['--username', 'claude', '--accept-terms']);

    expect(exit).toBe(1);
    expect(stderr).toContain('Beeper could not create the account claude (HTTP 409): That username is taken');
    expect(mock.createdAccounts).toEqual([]);
    expect(await readFile(envFile, 'utf8')).toBe(`BEEPER_BASE_URL=${baseUrl}\n`);
  }, 60_000);

  it('signs the new token out when it cannot be saved, and says how to start again', async () => {
    // A symlink to nowhere where the env file goes: saving refuses it. The
    // endpoint comes from the environment instead.
    await rm(envFile);
    await symlink(join(dir, 'missing', '.env'), envFile);
    const env = { BEEPER_BASE_URL: baseUrl };
    // One that encryption setup would reset, if it ran.
    mock.newAccountState = 'needs-cross-signing-setup';
    const { request, code } = await start(env);

    const { stdout, stderr, code: exit } = await finish(request, code, ['--accept-terms'], env);

    expect(exit).toBe(1);
    const [account] = mock.createdAccounts;
    expect(stderr).toContain(`Created the Beeper account ${account!.userID}, but could not save its token`);
    expect(stderr).toContain('is a symlink to a file that does not exist');
    expect(stderr).toContain('The token was signed out, so it works nowhere.');
    expect(stderr).toContain('deploy/assistant-beeper.sh --reset');
    expect(mock.signedOutTokens).toEqual([account!.accessToken]);
    expect(stdout + stderr).not.toContain(account!.accessToken);
    // Encryption is never set up for an account nothing here can use.
    expect(posted(RESET)).toEqual([]);
  }, 60_000);

  it('picks encryption setup up where it stopped, with a key of its own each time', async () => {
    mock.newAccountState = 'needs-cross-signing-setup';
    mock.failSetup = (path) => (path === CONFIRM ? { status: 500, message: 'Beeper is busy' } : undefined);
    const { request, code } = await start();

    const stopped = await finish(request, code, ['--accept-terms']);

    expect(stopped.code).toBe(1);
    expect(stopped.stdout).toContain('If this stops, the account stays; finish with: claude-messenger signup encrypt');
    // Status only: an answer to the request that carried the key could echo it.
    expect(stopped.stderr).toContain('Beeper could not put the new encryption in use (HTTP 500).');
    // The account and its token stay.
    const [account] = mock.createdAccounts;
    expect(await readFile(envFile, 'utf8')).toContain(`BEEPER_ACCESS_TOKEN=${account!.accessToken}\n`);

    mock.failSetup = undefined;
    const resumed = await cli(['signup', 'encrypt']);

    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('✓ The account is ready, its encryption set up.');
    expect(mock.recoveryKeys.map((k) => k.confirmed)).toEqual([false, true]);
    const output = stopped.stdout + stopped.stderr + resumed.stdout + resumed.stderr;
    for (const { key } of mock.recoveryKeys) expect(output).not.toContain(key);
  }, 60_000);

  it('gives up when --timeout runs out, saying what is done stays done', async () => {
    mock.signedIn = true;
    mock.setupState = 'needs-first-sync';
    mock.firstSyncPolls = 1000;
    await writeFile(envFile, `BEEPER_BASE_URL=${baseUrl}\nBEEPER_ACCESS_TOKEN=${mock.token}\n`);

    const { stderr, code } = await cli(['signup', 'encrypt', '--timeout', '0.03']);

    expect(code).toBe(1);
    expect(stderr).toContain(
      'Beeper had not finished setting up the account within 2 s (it reports "needs-first-sync"). What is done stays done.',
    );
  }, 60_000);

  // An account other than a new one (the owner's, if the token in the .env
  // were theirs) is guarded twice; each guard is proven alone here, the other
  // out of the way, beside the test above where neither stops a new account
  // Beeper left without encryption.
  describe('never sets up afresh the encryption of an account with something to lose', () => {
    beforeEach(async () => {
      mock.signedIn = true;
      await writeFile(envFile, `BEEPER_BASE_URL=${baseUrl}\nBEEPER_ACCESS_TOKEN=${mock.token}\n`);
    });

    it('refuses one that set up its encryption before, elsewhere, with no chat networks either', async () => {
      mock.setupState = 'needs-verification';

      const { stderr, code } = await cli(['signup', 'encrypt']);

      expect(code).toBe(1);
      expect(stderr).toContain('This account set up its encryption before, elsewhere (Beeper reports "needs-verification")');
      expect(stderr).toContain("with the account's recovery key");
      expect(posted(RESET)).toEqual([]);
    }, 60_000);

    // A new account passes through it on its own, so it is no refusal, but
    // whatever account sits there, nothing is reset while it does.
    it('waits out needs-secrets without resetting, until --timeout runs out', async () => {
      mock.setupState = 'needs-secrets';
      mock.secretsPolls = 1000;

      const { stderr, code } = await cli(['signup', 'encrypt', '--timeout', '0.03']);

      expect(code).toBe(1);
      expect(stderr).toContain('within 2 s (it reports "needs-secrets"). What is done stays done.');
      expect(posted(RESET)).toEqual([]);
    }, 60_000);

    it('refuses one that never had encryption but has a chat network connected', async () => {
      mock.setupState = 'needs-cross-signing-setup';
      mock.chats = [beeperOwnChat(), wireChat()];

      const { stderr, code } = await cli(['signup', 'encrypt']);

      expect(code).toBe(1);
      expect(stderr).toContain('This account has chat networks connected (whatsapp)');
      expect(posted(RESET)).toEqual([]);
    }, 60_000);
  });
});
