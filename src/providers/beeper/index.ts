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
import { toAccount, toChat, toMessage } from './mapper.js';

export interface BeeperMessengerOptions {
  accessToken: string;
  /**
   * Beeper Client API endpoint. Local Beeper Desktop, a tunnel to it, and a
   * headless Beeper Server all serve the same API — only this URL differs.
   */
  baseUrl?: string;
}

/** Messenger adapter for the Beeper Client API (Desktop app or headless Server). */
export class BeeperMessenger implements Messenger {
  private readonly client: BeeperDesktop;
  private readonly baseUrl: string;

  constructor(options: BeeperMessengerOptions) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:23373';
    this.client = new BeeperDesktop({
      accessToken: options.accessToken,
      baseURL: this.baseUrl,
      maxRetries: 2,
    });
  }

  async whoami(): Promise<ServerInfo> {
    const info = await this.wrap(() => this.client.info.retrieve());
    return {
      appName: info.app.name,
      appVersion: info.app.version,
      baseUrl: this.baseUrl,
      remoteAccess: info.server.remote_access,
    };
  }

  async listAccounts(): Promise<Account[]> {
    const accounts = await this.wrap(() => this.client.accounts.list());
    return accounts.map(toAccount);
  }

  async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    const page = await this.wrap(() =>
      this.client.chats.search({
        ...(query?.query !== undefined && { query: query.query }),
        ...(query?.type !== undefined && { type: query.type }),
        ...(query?.accountIds !== undefined && { accountIDs: query.accountIds }),
        ...(query?.unreadOnly !== undefined && { unreadOnly: query.unreadOnly }),
        ...(query?.includeMuted !== undefined && { includeMuted: query.includeMuted }),
        ...(query?.inbox !== undefined && { inbox: query.inbox }),
        ...(query?.lastActivityAfter !== undefined && { lastActivityAfter: query.lastActivityAfter }),
        ...(query?.lastActivityBefore !== undefined && { lastActivityBefore: query.lastActivityBefore }),
        limit: query?.limit ?? 20,
        ...(query?.cursor !== undefined && { cursor: query.cursor }),
      }),
    );
    return {
      items: page.items.map(toChat),
      hasMore: page.hasMore,
      ...(page.oldestCursor !== null && { nextCursor: page.oldestCursor }),
    };
  }

  async getChat(chatId: string): Promise<Chat> {
    const chat = await this.wrap(() => this.client.chats.retrieve(chatId));
    return toChat(chat);
  }

  async listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    const page = await this.wrap(() =>
      this.client.messages.list(chatId, {
        ...(query?.cursor !== undefined && { cursor: query.cursor }),
      }),
    );
    return {
      items: page.items.map(toMessage),
      hasMore: page.hasMore,
      ...(page.oldestCursor !== null && { nextCursor: page.oldestCursor }),
    };
  }

  async searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    const page = await this.wrap(() =>
      this.client.messages.search({
        ...(query.query !== undefined && { query: query.query }),
        ...(query.chatIds !== undefined && { chatIDs: query.chatIds }),
        ...(query.accountIds !== undefined && { accountIDs: query.accountIds }),
        ...(query.chatType !== undefined && { chatType: query.chatType }),
        ...(query.dateAfter !== undefined && { dateAfter: query.dateAfter }),
        ...(query.dateBefore !== undefined && { dateBefore: query.dateBefore }),
        ...(query.mediaTypes !== undefined && { mediaTypes: query.mediaTypes }),
        ...(query.includeMuted !== undefined && { includeMuted: query.includeMuted }),
        limit: query.limit ?? 20,
        ...(query.cursor !== undefined && { cursor: query.cursor }),
      }),
    );
    return {
      items: page.items.map(toMessage),
      hasMore: page.hasMore,
      ...(page.oldestCursor !== null && { nextCursor: page.oldestCursor }),
    };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const result = await this.wrap(() =>
      this.client.messages.send(input.chatId, {
        text: input.text,
        ...(input.replyToMessageId !== undefined && { replyToMessageID: input.replyToMessageId }),
      }),
    );
    return { chatId: result.chatID, pendingMessageId: result.pendingMessageID };
  }

  async markChatRead(chatId: string): Promise<void> {
    await this.wrap(() => this.client.chats.markRead(chatId));
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
          throw new NotFoundError(err.message, { cause: err });
        }
        throw new ProviderError(`Beeper API error (${err.status}): ${err.message}`, { cause: err });
      }
      throw new ProviderError(err instanceof Error ? err.message : String(err), { cause: err });
    }
  }
}
