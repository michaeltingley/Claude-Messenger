#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, loadEndpointConfig, saveAccessToken } from '../config.js';
import { createAccessRequester, createApp } from '../app.js';
import { watchMentions } from '../assistant/mentions.js';
import type { AccessProgress, AccessRequest } from '../core/access.js';
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

program
  .command('chats')
  .description('Search or list chats')
  .option('-q, --query <text>', 'search titles/participants')
  .option('-n, --limit <n>', 'max results (1-50)', parseLimit, 10)
  .option('--unread', 'unread only')
  .action(async (opts: { query?: string; limit: number; unread?: boolean }) => {
    const { messenger } = await app();
    const page = await messenger.searchChats({
      query: opts.query,
      unreadOnly: opts.unread,
      limit: opts.limit,
    });
    for (const c of page.items) {
      const unread = c.unreadCount > 0 ? `  [${c.unreadCount} unread]` : '';
      console.log(`${c.id}\n    ${c.network} · ${c.type} · ${c.title}${unread}`);
    }
    if (page.hasMore) console.log(`\n(more available — cursor: ${page.nextCursor})`);
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
      console.log(`[${m.timestamp}] ${who}: ${m.text ?? ''}${attachments}`);
    }
  });

program
  .command('search <query>')
  .description('Word search across all messages')
  .option('-n, --limit <n>', 'max results (1-50)', parseLimit, 10)
  .action(async (query: string, opts: { limit: number }) => {
    const { messenger } = await app();
    const page = await messenger.searchMessages({ query, limit: opts.limit });
    for (const m of page.items) {
      const who = m.isFromMe ? 'me' : (m.senderName ?? m.senderId);
      console.log(`[${m.timestamp}] (${m.chatId}) ${who}: ${m.text ?? ''}`);
    }
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
