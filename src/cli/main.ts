#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { createMcpServer } from '../mcp/server.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import { ConnectionError, MessengerError, PolicyDeniedError } from '../core/errors.js';

// Best-effort .env loading; explicit env vars always win.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — fine
}

const program = new Command('claude-messenger').description(
  'Policy-guarded bridge between Claude and your Beeper chats',
);

function fail(err: unknown): never {
  if (err instanceof PolicyDeniedError) {
    console.error(`✗ [${err.code}] Denied by policy rule ${err.rule}: ${err.message}`);
  } else if (err instanceof MessengerError) {
    console.error(`✗ [${err.code}] ${err.message}`);
  } else {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

async function app() {
  try {
    return await createApp(loadConfig());
  } catch (err) {
    fail(err);
  }
}

program
  .command('doctor')
  .description('Verify config, connectivity, auth, and policy end to end')
  .action(async () => {
    console.log('Claude Messenger — connection doctor\n');
    let config;
    try {
      config = loadConfig();
      console.log(`✓ Config OK (base URL: ${config.beeperBaseUrl})`);
    } catch (err) {
      fail(err);
    }
    const { raw, policy, policySource } = await createApp(config);
    try {
      const info = await raw.whoami();
      console.log(`✓ Connected: ${info.appName} ${info.appVersion} at ${info.baseUrl}`);
      console.log(`  remote access: ${info.remoteAccess ? 'enabled' : 'disabled (localhost only)'}`);
    } catch (err) {
      if (err instanceof ConnectionError) {
        console.error(`✗ ${err.message}`);
        console.error('\n  Checklist:');
        console.error('  1. Beeper Desktop (or Beeper Server) is running');
        console.error('  2. The Desktop API is enabled (Settings → Developers / Integrations)');
        console.error('  3. BEEPER_BASE_URL points where the API is reachable from this machine');
        process.exit(1);
      }
      fail(err);
    }
    try {
      const accounts = await raw.listAccounts();
      console.log(`✓ Auth OK — ${accounts.length} connected account(s):`);
      for (const a of accounts) {
        console.log(`    ${a.network.padEnd(12)} ${a.id}${a.user.fullName ? `  (${a.user.fullName})` : ''}`);
      }
    } catch (err) {
      fail(err);
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
    try {
      console.log(JSON.stringify(await messenger.listAccounts(), null, 2));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('chats')
  .description('Search or list chats')
  .option('-q, --query <text>', 'search titles/participants')
  .option('-n, --limit <n>', 'max results', '10')
  .option('--unread', 'unread only')
  .action(async (opts: { query?: string; limit: string; unread?: boolean }) => {
    const { messenger } = await app();
    try {
      const page = await messenger.searchChats({
        ...(opts.query !== undefined && { query: opts.query }),
        ...(opts.unread && { unreadOnly: true }),
        limit: Number(opts.limit),
      });
      for (const c of page.items) {
        const unread = c.unreadCount > 0 ? `  [${c.unreadCount} unread]` : '';
        console.log(`${c.id}\n    ${c.network} · ${c.type} · ${c.title}${unread}`);
      }
      if (page.hasMore) console.log(`\n(more available — cursor: ${page.nextCursor})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('messages <chatId>')
  .description('List recent messages in a chat')
  .action(async (chatId: string) => {
    const { messenger } = await app();
    try {
      const page = await messenger.listMessages(chatId);
      for (const m of [...page.items].reverse()) {
        const who = m.isFromMe ? 'me' : (m.senderName ?? m.senderId);
        const attachments = m.attachments.length ? ` [${m.attachments.map((a) => a.type).join(', ')}]` : '';
        console.log(`[${m.timestamp}] ${who}: ${m.text ?? ''}${attachments}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('search <query>')
  .description('Word search across all messages')
  .option('-n, --limit <n>', 'max results', '10')
  .action(async (query: string, opts: { limit: string }) => {
    const { messenger } = await app();
    try {
      const page = await messenger.searchMessages({ query, limit: Number(opts.limit) });
      for (const m of page.items) {
        const who = m.isFromMe ? 'me' : (m.senderName ?? m.senderId);
        console.log(`[${m.timestamp}] (${m.chatId}) ${who}: ${m.text ?? ''}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('send <chatId> <text>')
  .description('Send a message as you (policy-gated: requires send enabled + chat allowlisted)')
  .action(async (chatId: string, text: string) => {
    const { messenger } = await app();
    try {
      const result = await messenger.sendMessage({ chatId, text });
      console.log(`✓ Sent (pending ID ${result.pendingMessageId}) — recorded in audit log`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('policy-init')
  .description('Write the default read-only policy to the configured policy path')
  .action(async () => {
    const config = loadConfig();
    await writeFile(config.policyPath, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', {
      flag: 'wx',
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') fail(new Error(`${config.policyPath} already exists — edit it directly.`));
      throw err;
    });
    console.log(`✓ Wrote default (read-only) policy to ${config.policyPath}`);
  });

program
  .command('serve')
  .description('Run the MCP server on stdio (for Claude Code / Claude Desktop)')
  .action(async () => {
    const { messenger } = await app();
    const server = createMcpServer(messenger);
    await server.connect(new StdioServerTransport());
    // stdio transport: stdout belongs to the protocol; log to stderr only.
    console.error('claude-messenger MCP server running on stdio');
  });

await program.parseAsync(process.argv);
