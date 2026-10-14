#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, loadEndpointConfig, saveAccessToken } from '../config.js';
import { createAccessRequester, createAccountSignup, createApp, createLanguageModel, DEFAULT_LANGUAGE_MODEL } from '../app.js';
import { ActivityCollector } from '../assistant/digest/activity.js';
import { dayBefore, DigestWriter, isDigestWindow, MAX_DIGEST_DAYS } from '../assistant/digest/digest.js';
import { hostTimeZone, isTimeZone } from '../assistant/text/time.js';
import { watchMentions } from '../assistant/mentions.js';
import type { AccessProgress, AccessRequest } from '../core/access.js';
import type { AccountSignup } from '../core/signup.js';
import type { Message } from '../core/types.js';
import { createMcpServer } from '../mcp/server.js';
import { startHttpMcpServer } from '../mcp/http.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import { AuthError, ConnectionError, MessengerError, PolicyDeniedError } from '../core/errors.js';
import { packageVersion } from '../version.js';

/** The env file every command reads, in the working directory, and where `connect` saves the token. */
const ENV_FILE = '.env';

/**
 * Whether the environment itself carries a Beeper token. It wins over the
 * env file, so a token `connect` saves would go unused, and `connect` says so.
 */
const TOKEN_IN_ENVIRONMENT = process.env.BEEPER_ACCESS_TOKEN !== undefined;

// Best-effort .env loading; explicit env vars always win. Requires Node
// >= 20.12 (enforced via package.json engines).
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // no .env file — fine
}

const program = new Command('claude-messenger')
  .description('Policy-guarded bridge between Claude and your Beeper chats')
  .version(packageVersion());

function fail(err: unknown): never {
  if (err instanceof PolicyDeniedError) {
    console.error(`✗ [${err.code}] Denied by policy rule ${err.rule}: ${err.message}`);
  } else if (err instanceof ConnectionError) {
    console.error(`✗ [${err.code}] ${err.message}`);
    console.error('\n  Checklist:');
    console.error('  1. Beeper Desktop (or Beeper Server) is running');
    console.error('  2. The Desktop API is enabled (Settings → Developers / Integrations)');
    console.error('  3. BEEPER_BASE_URL points where the API is reachable from this machine');
  } else if (err instanceof MessengerError) {
    console.error(`✗ [${err.code}] ${err.message}`);
    if (err instanceof AuthError) console.error('  Get a new token with: claude-messenger connect');
  } else {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

const app = async () => createApp(loadConfig());

/**
 * At most a day. A longer wait gains nothing, and past 24.8 days Node's
 * timers overflow, which would end the wait at once instead.
 */
const MAX_WAIT_MINUTES = 1440;

function parseMinutes(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_WAIT_MINUTES) {
    throw new InvalidArgumentError(`must be a number of minutes, more than 0 and at most ${MAX_WAIT_MINUTES}`);
  }
  return n;
}

/** One line per step of `connect`'s wait, in the person's terms. */
function describeProgress(progress: AccessProgress): string {
  switch (progress.kind) {
    case 'action-required':
      return `${progress.step} Waiting...`;
    case 'approval-requested':
      return progress.attempt === 1
        ? 'The approval box is open. Waiting for your answer...'
        : 'The unanswered approval box closed. A new one is open...';
  }
}

/**
 * An ISO 8601 date and time with its zone, so it names the same moment on
 * every machine. Date.parse alone reads far more ("5" is May 2001) and
 * rolls an impossible date over (February 30 is March 2).
 */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseTime(value: string): string {
  const parts = ISO_TIME.exec(value);
  const ms = Date.parse(value);
  const dayExists = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (parts === null || Number.isNaN(ms) || !dayExists(Number(parts[1]), Number(parts[2]), Number(parts[3]))) {
    throw new InvalidArgumentError('must be a date and time with its zone, like 2026-10-13T09:00:00Z or 2026-10-13T05:00:00-04:00');
  }
  return new Date(ms).toISOString();
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new InvalidArgumentError('must be an integer between 1 and 50');
  }
  return n;
}

/** Where a digest starts: a time with its zone, in the past, no further back than a digest reads. */
function parseSince(value: string): Date {
  const since = new Date(parseTime(value));
  if (!isDigestWindow({ since, until: new Date() })) {
    throw new InvalidArgumentError(`must be in the past, at most ${MAX_DIGEST_DAYS} days back`);
  }
  return since;
}

function parseEmail(value: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new InvalidArgumentError('must be an email address');
  return value;
}

/**
 * Sets up a new account's encryption, saying what Beeper is doing, and how
 * to pick up again if this stops: the account and its token stay.
 */
async function setUpEncryption(accountSignup: AccountSignup, token: string, minutes: number): Promise<void> {
  console.log('Setting up its encryption. If this stops, the account stays; finish with: claude-messenger signup encrypt');
  await accountSignup.setUpEncryption(token, {
    timeoutMs: minutes * 60_000,
    onProgress: (step) => console.log(step),
  });
  console.log('✓ The account is ready, its encryption set up.');
}

function parseTimeZone(value: string): string {
  if (!isTimeZone(value)) throw new InvalidArgumentError('must be an IANA time zone, such as America/Los_Angeles');
  return value;
}

program
  .command('doctor')
  .description('Verify config, connectivity, auth, and policy end to end')
  .action(async () => {
    console.log('Claude Messenger — connection doctor\n');
    const config = loadConfig();
    console.log(`✓ Config OK (base URL: ${config.beeperBaseUrl})`);
    const { messenger, probe, policy, policySource } = await createApp(config);

    const info = await probe.checkConnection();
    console.log(`✓ Connected: ${info.appName} ${info.appVersion} at ${info.baseUrl}`);
    console.log(`  remote access: ${info.remoteAccess ? 'enabled' : 'disabled (localhost only)'}`);

    // Deliberately the guarded messenger: account identities obey the read
    // policy and the access itself is audited, even in diagnostics.
    const accounts = await messenger.listAccounts();
    console.log(`✓ Auth OK — ${accounts.length} account(s) visible under the current policy:`);
    for (const a of accounts) {
      console.log(`    ${a.network.padEnd(12)} ${a.id}${a.user.fullName ? `  (${a.user.fullName})` : ''}`);
    }

    console.log(`✓ Policy: ${policySource === 'file' ? config.policyPath : 'built-in default (read-only)'}`);
    console.log(`    read: ${policy.capabilities.read}   send: ${policy.capabilities.send}   markRead: ${policy.capabilities.markRead}`);
    if (policy.capabilities.send) {
      const list = policy.send.chatAllowlist;
      console.log(`    send allowlist: ${list === '*' ? '* (ALL CHATS — consider narrowing)' : `${list.length} chat(s)`}`);
    }
    console.log('\nAll checks passed. Try: claude-messenger chats');
  });

program
  .command('accounts')
  .description('List connected chat-network accounts (policy-filtered)')
  .action(async () => {
    const { messenger } = await app();
    console.log(JSON.stringify(await messenger.listAccounts(), null, 2));
  });

/**
 * What a listing prints when more remain: the run that picks up where it
 * stopped. The cursor is the provider's own and may hold anything, so it is
 * quoted to paste into a shell as it is. Without one, the rest can't be
 * asked for, but they are there.
 */
const moreAvailable = (cursor: string | undefined) =>
  cursor === undefined
    ? '\n(more available, with no cursor to get them)'
    : `\n(more available — run again with --cursor '${cursor.replaceAll("'", `'\\''`)}')`;

program
  .command('chats')
  .description('Search or list chats')
  .option('-q, --query <text>', 'search titles/participants')
  .option('-n, --limit <n>', 'max results (1-50)', parseLimit, 10)
  .option('--unread', 'unread only')
  .option('--cursor <cursor>', 'pick up where an earlier run said more were available')
  .action(async (opts: { query?: string; limit: number; unread?: boolean; cursor?: string }) => {
    const { messenger } = await app();
    const page = await messenger.searchChats({
      query: opts.query,
      unreadOnly: opts.unread,
      limit: opts.limit,
      cursor: opts.cursor,
    });
    for (const c of page.items) {
      const unread = c.unreadCount > 0 ? `  [${c.unreadCount} unread]` : '';
      console.log(`${c.id}\n    ${c.network} · ${c.type} · ${c.title}${unread}`);
    }
    if (page.hasMore) console.log(moreAvailable(page.nextCursor));
  });

program
  .command('messages <chatId>')
  .description('List recent messages in a chat (oldest first)')
  .action(async (chatId: string) => {
    const { messenger } = await app();
    const page = await messenger.listMessages(chatId);
    for (const m of [...page.items].reverse()) {
      const who = m.isFromMe ? 'me' : (m.senderName ?? m.senderId);
      const attachments = m.attachments.length ? ` [${m.attachments.map((a) => a.type).join(', ')}]` : '';
      console.log(`[${m.timestamp}] ${who}: ${m.text}${attachments}`);
    }
  });

/**
 * The most pages `search` reads to fill its limit. A page can hold fewer
 * than asked for while more remain: a provider's pages have a size of their
 * own (Beeper's hold 20), and policy hides the matches in chats it denies.
 * So a search goes on to the next page, but not through every match a
 * policy hides.
 */
const SEARCH_MAX_PAGES = 10;

program
  .command('search <query>')
  .description('Word search across all messages, newest first')
  .option('-n, --limit <n>', 'max results (1-50)', parseLimit, 10)
  .option('--cursor <cursor>', 'pick up where an earlier run said more were available')
  .action(async (query: string, opts: { limit: number; cursor?: string }) => {
    const { messenger } = await app();
    const found: Message[] = [];
    let cursor = opts.cursor;
    let more = false;
    for (let pages = 0; pages < SEARCH_MAX_PAGES && found.length < opts.limit; pages++) {
      const page = await messenger.searchMessages({ query, limit: opts.limit - found.length, cursor });
      found.push(...page.items);
      more = page.hasMore;
      cursor = page.nextCursor;
      if (!more || cursor === undefined) break;
    }
    for (const m of found) {
      const who = m.isFromMe ? 'me' : (m.senderName ?? m.senderId);
      console.log(`[${m.timestamp}] (${m.chatId}) ${who}: ${m.text}`);
    }
    if (more) console.log(moreAvailable(cursor));
  });

program
  .command('digest')
  .description('Write a digest of your recent chats: what needs you first, then the rest (needs Claude Code signed in here)')
  .option(
    '--since <time>',
    `where it starts, like 2026-10-12T07:46:00-07:00, at most ${MAX_DIGEST_DAYS} days back (default: 24 hours ago)`,
    parseSince,
  )
  .option('--time-zone <zone>', "the IANA time zone to give times in (default: this host's)", parseTimeZone)
  .option('--model <name>', 'the Claude model that writes it', DEFAULT_LANGUAGE_MODEL)
  .action(async (opts: { since?: Date; timeZone?: string; model: string }) => {
    const until = new Date();
    const window = opts.since === undefined ? dayBefore(until) : { since: opts.since, until };
    const { messenger } = await app();
    const writer = new DigestWriter(new ActivityCollector(messenger), createLanguageModel({ model: opts.model }));
    console.log(await writer.write(window, opts.timeZone ?? hostTimeZone()));
  });

program
  .command('send <chatId> <text>')
  .description('Send a message as you (policy-gated: requires send enabled + chat allowlisted)')
  .action(async (chatId: string, text: string) => {
    const { messenger } = await app();
    const result = await messenger.sendMessage({ chatId, text });
    console.log(`✓ Sent (pending ID ${result.pendingMessageId}) — recorded in audit log`);
  });

/** What `mentions` prints for each one: where it is, when, and what it says. */
function mentionLine({ id, chatId, accountId, timestamp, text, replyToMessageId }: Message): string {
  return JSON.stringify({ id, chatId, accountId, timestamp, text, replyToMessageId });
}

program
  .command('mentions')
  .description('Follow the messages you send that mention @Claude, one JSON line each, until stopped')
  .option('--since <time>', 'also catch up on mentions after this time, like 2026-10-13T09:00:00Z (default: now)', parseTime)
  .action(async (opts: { since?: string }) => {
    const { messenger } = await app();
    const since = opts.since ?? new Date().toISOString();
    const stop = new AbortController();
    // Once each: a second Ctrl-C finds no handler and ends the process at once.
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());
    console.error(`Watching for @Claude in messages you send after ${since}. Ctrl-C stops.`);
    for await (const message of watchMentions(messenger, since, stop.signal)) {
      console.log(mentionLine(message));
    }
    console.error('Stopped.');
  });

program
  .command('connect')
  .description(`Get a Beeper access token through Beeper's own approval box and save it to ${ENV_FILE}, never displayed`)
  .option('--allow-send', 'also ask for write access (sending, marking read); the policy still decides')
  .option('--timeout <minutes>', 'how long to wait for sign-in and approval', parseMinutes, 15)
  .action(async (opts: { allowSend?: boolean; timeout: number }) => {
    const requester = createAccessRequester(loadEndpointConfig());
    const request: AccessRequest = {
      clientName: 'Claude Messenger',
      write: Boolean(opts.allowSend),
      timeoutMs: opts.timeout * 60_000,
      onProgress: (progress) => console.log(describeProgress(progress)),
    };
    // The token goes from the provider straight into the env file. The person
    // sees only the provider's own window, so the token never passes through
    // a terminal, a chat or a screen, and a session's transcript never holds it.
    for (const line of requester.instructions(request)) console.log(line);
    console.log(`Waiting up to ${opts.timeout} min...`);
    const grant = await requester.requestAccess(request);

    let replaced: boolean;
    try {
      ({ replaced } = await saveAccessToken(ENV_FILE, grant.token));
    } catch (err) {
      // A token this command could not keep must not keep working either.
      const revoked = await grant.revoke().then(
        () => true,
        () => false,
      );
      throw new Error(
        `Could not save the token to ${ENV_FILE} (${(err as Error).message}). ` +
          (revoked ? 'It was revoked.' : `It still works until you revoke it ${requester.revokeByHand}.`),
        { cause: err },
      );
    }
    console.log(
      `✓ Approved (${grant.write ? 'read and write' : 'read only'}). The token is in ${ENV_FILE}; it was never displayed.`,
    );
    if (request.write && !grant.write) {
      console.log('  Sending was not allowed in the approval box, so it will not work even where the policy allows it.');
    }
    if (replaced) {
      console.log(`  It replaced an earlier token, which still works until you revoke it ${requester.revokeByHand}.`);
    }
    if (TOKEN_IN_ENVIRONMENT) {
      console.log(
        `⚠ BEEPER_ACCESS_TOKEN is also set in this command's environment, and that wins over ${ENV_FILE}. ` +
          'Remove it there, or commands keep using the old token.',
      );
    }
    console.log('Next: claude-messenger doctor');
  });

const signup = program
  .command('signup')
  .description(
    `Create an account of this app's own, for the assistant, on the Beeper endpoint ${ENV_FILE} names, saving its token there, never displayed`,
  );

signup
  .command('start')
  .description("Have Beeper email a sign-up code to the new account's address")
  .requiredOption('--email <address>', "the new account's email address", parseEmail)
  .action(async (opts: { email: string }) => {
    const request = await createAccountSignup(loadEndpointConfig()).sendCode(opts.email);
    console.log(`✓ Beeper emailed a sign-up code to ${opts.email}.`);
    console.log('Next, with that code:');
    console.log(`  claude-messenger signup finish --request ${request.id} --code <code> --accept-terms [--username <name>]`);
  });

signup
  .command('finish')
  .description(`Create the account with the emailed code, save its token to ${ENV_FILE}, and set up its encryption`)
  .requiredOption('--request <id>', 'the request `signup start` printed')
  .requiredOption('--code <code>', 'the code Beeper emailed')
  .option('--username <name>', "the account's username (default: Beeper's first suggestion)")
  .option('--accept-terms', "agree to Beeper's Terms of Use and Privacy Policy for the new account")
  .option('--timeout <minutes>', 'how long to wait for Beeper to set the account up', parseMinutes, 5)
  .action(async (opts: { request: string; code: string; username?: string; acceptTerms?: boolean; timeout: number }) => {
    // Before Beeper hears of it: the code works once.
    if (!opts.acceptTerms) {
      throw new Error(
        "Creating a Beeper account accepts Beeper's Terms of Use (https://www.beeper.com/terms-onboarding) and " +
          'Privacy Policy (https://www.beeper.com/privacy) for it. Pass --accept-terms once its owner has agreed. ' +
          'Nothing was sent to Beeper.',
      );
    }
    const accountSignup = createAccountSignup(loadEndpointConfig());
    const account = await accountSignup.createAccount({ id: opts.request }, opts.code, {
      ...(opts.username !== undefined && { username: opts.username }),
      acceptTerms: true,
    });

    let replaced: boolean;
    try {
      ({ replaced } = await saveAccessToken(ENV_FILE, account.token));
    } catch (err) {
      // A token this command could not keep must not keep working either.
      const signedOut = await account.signOut().then(
        () => true,
        () => false,
      );
      throw new Error(
        `Created the Beeper account ${account.userId}, but could not save its token to ${ENV_FILE} ` +
          `(${(err as Error).message}). ` +
          (signedOut ? 'The token was signed out, so it works nowhere.' : 'Signing the token out failed, so it still works.') +
          ' Nothing here can use that account. To sign up again, with another address, first delete what Beeper ' +
          "here kept of it (for the assistant's runtime: deploy/assistant-beeper.sh --reset).",
        { cause: err },
      );
    }
    console.log(`✓ Created the Beeper account ${account.userId}. Its token is in ${ENV_FILE}; it was never displayed.`);
    if (replaced) console.log(`  It replaced an earlier token in ${ENV_FILE}.`);
    if (TOKEN_IN_ENVIRONMENT) {
      console.log(
        `⚠ BEEPER_ACCESS_TOKEN is also set in this command's environment, and that wins over ${ENV_FILE}. ` +
          'Remove it there, or commands keep using another token.',
      );
    }
    await setUpEncryption(accountSignup, account.token, opts.timeout);
  });

signup
  .command('encrypt')
  .description(`Set up the encryption of the account whose token is in ${ENV_FILE}, if \`signup finish\` stopped short`)
  .option('--timeout <minutes>', 'how long to wait for Beeper to set the account up', parseMinutes, 5)
  .action(async (opts: { timeout: number }) => {
    const config = loadConfig();
    await setUpEncryption(createAccountSignup(config), config.beeperAccessToken, opts.timeout);
  });

program
  .command('policy-init')
  .description('Write the default read-only policy to the configured policy path')
  .action(async () => {
    const config = loadConfig();
    try {
      await writeFile(config.policyPath, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${config.policyPath} already exists — edit it directly.`);
      }
      throw err;
    }
    console.log(`✓ Wrote default (read-only) policy to ${config.policyPath}`);
  });

program
  .command('serve')
  .description('Run the MCP server: stdio by default, or --http for hosted/remote use')
  .option('--http', 'serve Streamable HTTP MCP instead of stdio')
  .option('--port <n>', 'HTTP port', (v: string) => Number(v), 8484)
  .option(
    '--host <addr>',
    'HTTP bind address; keep 127.0.0.1 and expose via Tailscale/cloudflared',
    '127.0.0.1',
  )
  .action(async (opts: { http?: boolean; port: number; host: string }) => {
    const config = loadConfig();
    const { messenger } = await createApp(config);

    if (!opts.http) {
      const server = createMcpServer(messenger, packageVersion());
      await server.connect(new StdioServerTransport());
      // stdio transport: stdout belongs to the protocol; log to stderr only.
      console.error('claude-messenger MCP server running on stdio');
      return;
    }

    if (!config.mcpToken) {
      throw new Error(
        'serve --http requires CLAUDE_MESSENGER_MCP_TOKEN (generate one: openssl rand -hex 32). ' +
          'It is the bearer token remote MCP clients must present.',
      );
    }
    // Warn BEFORE binding: once listen() returns, the endpoint is live.
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
      console.error(
        `⚠ binding to ${opts.host} — every interface this address reaches can attempt the bearer token.\n` +
          '  Intended setup: bind 127.0.0.1 and expose via `tailscale serve` (see docs/DEPLOY.md).',
      );
    }
    const running = await startHttpMcpServer({
      createMcpServer: () => createMcpServer(messenger, packageVersion()),
      authToken: config.mcpToken,
      port: opts.port,
      host: opts.host,
    });
    console.log(`claude-messenger MCP server listening on http://${running.host}:${running.port}/mcp`);

    // A hosted service must stop cleanly on `systemctl stop`/restart. Under
    // the unit's PrivatePIDs sandbox this is PID 1 in its own namespace, where
    // the kernel delivers only signals the process has installed a handler
    // for — so without this, SIGTERM is dropped and systemd waits out its stop
    // timeout before resorting to SIGKILL. Stop accepting, let in-flight work
    // settle, then exit; an unref'd backstop bounds a close that an idle
    // keep-alive connection would otherwise stall, and never holds the process
    // open on its own.
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        setTimeout(() => process.exit(0), 5000).unref();
        void running.close().finally(() => process.exit(0));
      });
    }
  });

// Single error boundary: every command failure — config, policy file,
// connection, policy denial — exits through fail() with a consistent format.
try {
  await program.parseAsync(process.argv);
} catch (err) {
  fail(err);
}
