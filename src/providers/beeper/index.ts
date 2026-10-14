import BeeperDesktop, { APIConnectionError, APIError } from '@beeper/desktop-api';
import type { Messenger } from '../../core/messenger.js';
import type {
  Account,
  Chat,
  ChatQuery,
  Message,
  MessageListQuery,
  MessageSearchQuery,
  MessageWatchQuery,
  Page,
  SendMessageInput,
  SendMessageResult,
  ServerInfo,
} from '../../core/types.js';
import { AuthError, ConnectionError, NotFoundError, ProviderError } from '../../core/errors.js';
import { watchByPolling } from '../watch-by-polling.js';
import { newestFirst, toAccount, toChat, toMessage, toPage } from './mapper.js';

export interface BeeperMessengerOptions {
  accessToken: string;
  /**
   * Beeper Client API endpoint. Local Beeper Desktop, a tunnel to it, and a
   * headless Beeper Server all serve the same API — only this URL differs.
   */
  baseUrl?: string;
  /** Transport-level retries for connection failures/5xx (default 2). */
  maxRetries?: number;
  /** How often a message watch asks Beeper for new messages (default 5 s). */
  pollIntervalMs?: number;
}

/** The largest page Beeper's message search serves, per its published API reference. */
const SEARCH_PAGE_LIMIT = 20;

/** Messenger adapter for the Beeper Client API (Desktop app or headless Server). */
export class BeeperMessenger implements Messenger {
  private readonly client: BeeperDesktop;
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly pollIntervalMs: number;

  constructor(options: BeeperMessengerOptions) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:23373';
    this.accessToken = options.accessToken;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.client = new BeeperDesktop({
      accessToken: options.accessToken,
      baseURL: this.baseUrl,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  checkConnection(): Promise<ServerInfo> {
    return this.wrap(async () => {
      const info = await this.client.info.retrieve();
      return {
        appName: info.app.name,
        appVersion: info.app.version,
        baseUrl: this.baseUrl,
        remoteAccess: info.server.remote_access,
      };
    });
  }

  listAccounts(): Promise<Account[]> {
    return this.wrap(async () => (await this.client.accounts.list()).map(toAccount));
  }

  searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    return this.wrap(async () =>
      toPage(
        await this.client.chats.search({
          query: query?.query,
          type: query?.type,
          accountIDs: query?.accountIds,
          unreadOnly: query?.unreadOnly,
          includeMuted: query?.includeMuted,
          inbox: query?.inbox,
          lastActivityAfter: query?.lastActivityAfter,
          lastActivityBefore: query?.lastActivityBefore,
          limit: query?.limit ?? 20,
          cursor: query?.cursor,
        }),
        toChat,
      ),
    );
  }

  getChat(chatId: string): Promise<Chat> {
    return this.wrap(async () => toChat(await this.client.chats.retrieve(chatId)));
  }

  listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    return this.wrap(async () => {
      const { items, hasMore, oldestCursor } = await this.client.messages.list(chatId, { cursor: query?.cursor });
      // The wire contract says only "sorted by timestamp", not which way.
      // Pin the domain contract — newest first within a page — locally.
      return toPage({ items: [...items].sort(newestFirst), hasMore, oldestCursor }, toMessage);
    });
  }

  searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    return this.wrap(async () => {
      const { items, hasMore, oldestCursor } = await this.client.messages.search({
        query: query.query,
        chatIDs: query.chatIds,
        accountIDs: query.accountIds,
        chatType: query.chatType,
        dateAfter: query.dateAfter,
        dateBefore: query.dateBefore,
        mediaTypes: query.mediaTypes,
        // Beeper leaves out low-priority chats unless asked not to. Search
        // covers every chat, as the port says and a watch does.
        excludeLowPriority: false,
        includeMuted: query.includeMuted,
        // A larger limit gets fewer, with a cursor to the rest, as paging allows.
        limit: Math.min(query.limit ?? SEARCH_PAGE_LIMIT, SEARCH_PAGE_LIMIT),
        cursor: query.cursor,
      });
      // Pages run newest first, but within one the reference's example puts
      // the newest last. Pin the domain contract, newest first within a page
      // too, as listMessages does.
      return toPage({ items: [...items].sort(newestFirst), hasMore, oldestCursor }, toMessage);
    });
  }

  /**
   * Beeper's push events (`/v1/ws`) are experimental, so a watch polls message
   * search instead: see watchByPolling for what it delivers, and how late.
   */
  watchMessages(query: MessageWatchQuery, signal: AbortSignal): AsyncIterable<Message> {
    return watchByPolling(
      {
        since: query.since,
        intervalMs: this.pollIntervalMs,
        fetchPage: (request) =>
          this.wrap(async () =>
            toPage(
              await this.client.messages.search(
                {
                  sender: query.sender,
                  dateAfter: request.dateAfter,
                  // Search leaves out low-priority chats by default. A watch
                  // reads every chat the policy shows, so it asks for them too.
                  excludeLowPriority: false,
                  includeMuted: true,
                  limit: SEARCH_PAGE_LIMIT,
                  cursor: request.cursor,
                },
                // No retries: the SDK waits between them as long as Beeper's
                // Retry-After says, and an abort can't cut that wait short. A
                // failure ends the watch instead, as its contract says.
                { signal: request.signal, maxRetries: 0 },
              ),
              toMessage,
            ),
          ),
      },
      signal,
    );
  }

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.wrap(async () => {
      const result = await this.client.messages.send(input.chatId, {
        text: input.text,
        replyToMessageID: input.replyToMessageId,
      });
      return { chatId: result.chatID, pendingMessageId: result.pendingMessageID };
    });
  }

  markChatRead(chatId: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.chats.markRead(chatId);
    });
  }

  /** Upstream error text can echo request details; never let the token through. */
  private redact(text: string): string {
    return this.accessToken.length > 0 ? text.split(this.accessToken).join('[redacted]') : text;
  }

  private async wrap<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof APIConnectionError) {
        throw new ConnectionError(
          `Cannot reach the Beeper Client API at ${this.baseUrl}. ` +
            'Is Beeper Desktop (or your Beeper Server) running, the Desktop API enabled, and the URL reachable from here?',
          { cause: err },
        );
      }
      if (err instanceof APIError) {
        if (err.status === 401 || err.status === 403) {
          throw new AuthError(
            'The Beeper Client API rejected the access token. Re-create it under Beeper Settings → Integrations → Approved connections.',
            { cause: err },
          );
        }
        if (err.status === 404) {
          throw new NotFoundError(this.redact(err.message), { cause: err });
        }
        throw new ProviderError(`Beeper API error (${err.status}): ${this.redact(err.message)}`, {
          cause: err,
        });
      }
      throw new ProviderError(this.redact(err instanceof Error ? err.message : String(err)), { cause: err });
    }
  }
}
