import BeeperDesktop, { APIConnectionError, APIError } from '@beeper/desktop-api';
import type { Messenger } from '../../core/messenger.js';
import type {
  Account,
  Chat,
  ChatQuery,
  Message,
  MessageListQuery,
  MessageSearchQuery,
  Page,
  SendMessageInput,
  SendMessageResult,
  ServerInfo,
} from '../../core/types.js';
import { AuthError, ConnectionError, NotFoundError, ProviderError } from '../../core/errors.js';
import { toAccount, toChat, toMessage, toPage } from './mapper.js';

export interface BeeperMessengerOptions {
  accessToken: string;
  /**
   * Beeper Client API endpoint. Local Beeper Desktop, a tunnel to it, and a
   * headless Beeper Server all serve the same API — only this URL differs.
   */
  baseUrl?: string;
  /** Transport-level retries for connection failures/5xx (default 2). */
  maxRetries?: number;
}

/** Messenger adapter for the Beeper Client API (Desktop app or headless Server). */
export class BeeperMessenger implements Messenger {
  private readonly client: BeeperDesktop;
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(options: BeeperMessengerOptions) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:23373';
    this.accessToken = options.accessToken;
    this.client = new BeeperDesktop({
      accessToken: options.accessToken,
      baseURL: this.baseUrl,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  whoami(): Promise<ServerInfo> {
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
      const page = toPage(await this.client.messages.list(chatId, { cursor: query?.cursor }), toMessage);
      // The wire contract says only "sorted by timestamp", not which way.
      // Pin the domain contract — newest first within a page — locally.
      page.items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return page;
    });
  }

  searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    return this.wrap(async () =>
      toPage(
        await this.client.messages.search({
          query: query.query,
          chatIDs: query.chatIds,
          accountIDs: query.accountIds,
          chatType: query.chatType,
          dateAfter: query.dateAfter,
          dateBefore: query.dateBefore,
          mediaTypes: query.mediaTypes,
          includeMuted: query.includeMuted,
          limit: query.limit ?? 20,
          cursor: query.cursor,
        }),
        toMessage,
      ),
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
