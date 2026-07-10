import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Messenger } from '../core/messenger.js';
import { MessengerError, PolicyDeniedError } from '../core/errors.js';

/**
 * Curated MCP tool surface over a (policy-guarded) Messenger.
 *
 * Deliberately narrower than the raw Beeper API: tools are read-heavy,
 * sending is a single explicit tool, and destructive operations (delete,
 * archive) are not exposed at all. The Messenger passed in is expected to be
 * a GuardedMessenger, so policy denials surface as tool errors that explain
 * which rule blocked the call.
 */
export function createMcpServer(messenger: Messenger, version: string): McpServer {
  const server = new McpServer({ name: 'claude-messenger', version });

  const asResult = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });

  const asError = (err: unknown) => {
    const message =
      err instanceof PolicyDeniedError
        ? `Denied by policy (${err.rule}): ${err.message}`
        : err instanceof MessengerError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
    return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      return asResult(await fn());
    } catch (err) {
      return asError(err);
    }
  };

  server.registerTool(
    'whoami',
    {
      title: 'Check connection',
      description:
        'Verify the connection to the message backend and return app/server info. Use this first if other tools fail.',
      inputSchema: {},
    },
    () => run(() => messenger.whoami()),
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List connected accounts',
      description: 'List the chat-network accounts (WhatsApp, Signal, ...) connected to the user\'s Beeper.',
      inputSchema: {},
    },
    () => run(() => messenger.listAccounts()),
  );

  server.registerTool(
    'search_chats',
    {
      title: 'Search chats',
      description:
        'Search or list chats. Omit query to get recent chats. Returns chat IDs used by the other tools.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search over chat titles/participants'),
        type: z.enum(['single', 'group', 'any']).optional(),
        unreadOnly: z.boolean().optional(),
        accountIds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional().describe('nextCursor from a previous page'),
      },
    },
    (args) => run(() => messenger.searchChats(args)),
  );

  server.registerTool(
    'get_chat',
    {
      title: 'Get chat details',
      description: 'Fetch one chat with its participant list.',
      inputSchema: { chatId: z.string() },
    },
    ({ chatId }) => run(() => messenger.getChat(chatId)),
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages in a chat',
      description: 'Messages in one chat, newest first. Paginate with cursor.',
      inputSchema: {
        chatId: z.string(),
        cursor: z.string().optional().describe('nextCursor from a previous page'),
      },
    },
    ({ chatId, cursor }) => run(() => messenger.listMessages(chatId, cursor !== undefined ? { cursor } : undefined)),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Word search across chats (literal words, any order — not semantic). Filter by chat, account, date range, or media type.',
      inputSchema: {
        query: z.string().optional(),
        chatIds: z.array(z.string()).optional(),
        accountIds: z.array(z.string()).optional(),
        chatType: z.enum(['single', 'group']).optional(),
        dateAfter: z.string().optional().describe('ISO 8601, strictly after'),
        dateBefore: z.string().optional().describe('ISO 8601, strictly before'),
        mediaTypes: z.array(z.enum(['any', 'video', 'image', 'link', 'file'])).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      },
    },
    (args) => run(() => messenger.searchMessages(args)),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description:
        'Send a message AS THE USER to a chat. This is a real send, visible to real people, and subject to policy ' +
        '(sending must be enabled and the chat allowlisted). Confirm intent with the user before calling unless they ' +
        'explicitly asked for this exact send.',
      inputSchema: {
        chatId: z.string(),
        text: z.string().min(1),
        replyToMessageId: z.string().optional(),
      },
    },
    (args) => run(() => messenger.sendMessage(args)),
  );

  server.registerTool(
    'mark_chat_read',
    {
      title: 'Mark chat read',
      description:
        'Mark a chat as read as the user (may emit read receipts visible to others). Subject to policy.',
      inputSchema: { chatId: z.string() },
    },
    ({ chatId }) => run(() => messenger.markChatRead(chatId)),
  );

  return server;
}
