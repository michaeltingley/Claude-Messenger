import type { Messenger } from '../src/core/messenger.js';
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
} from '../src/core/types.js';
import { NotFoundError } from '../src/core/errors.js';

export function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    accountId: 'whatsapp-1',
    network: 'whatsapp',
    type: 'single',
    title: 'Alice',
    unreadCount: 0,
    participants: [{ id: 'alice', fullName: 'Alice' }],
    ...overrides,
  };
}

/** A message whose plain text is its text, unless the overrides say otherwise. */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  const text = 'text' in overrides ? overrides.text : 'hello';
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    accountId: 'whatsapp-1',
    senderId: 'alice',
    senderName: 'Alice',
    isFromMe: false,
    timestamp: '2026-07-10T00:00:00Z',
    text,
    plainText: text,
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

/** In-memory Messenger for tests: seed chats/messages, records sends. */
export class FakeMessenger implements Messenger {
  chats: Chat[] = [];
  messages: Message[] = [];
  sent: SendMessageInput[] = [];
  markedRead: string[] = [];

  async checkConnection(): Promise<ServerInfo> {
    return { appName: 'FakeMessenger', appVersion: '0.0.0', baseUrl: 'fake://' };
  }

  async listAccounts(): Promise<Account[]> {
    const ids = new Map<string, Account>();
    for (const c of this.chats) {
      ids.set(c.accountId, { id: c.accountId, network: c.network, user: { id: 'me', isSelf: true } });
    }
    return [...ids.values()];
  }

  async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    let items = this.chats;
    if (query?.query) {
      const q = query.query.toLowerCase();
      items = items.filter((c) => c.title.toLowerCase().includes(q));
    }
    if (query?.unreadOnly) items = items.filter((c) => c.unreadCount > 0);
    // The main inbox is what isn't archived (low priority isn't modelled).
    if (query?.inbox === 'primary') items = items.filter((c) => !c.isArchived);
    const after = query?.lastActivityAfter;
    if (after !== undefined) {
      items = items.filter((c) => c.lastActivity !== undefined && Date.parse(c.lastActivity) > Date.parse(after));
    }
    return this.page(items, query?.cursor, query?.limit);
  }

  /** The most items one page holds; a longer result pages, older items on later pages. */
  pageSize = Infinity;

  private page<T>(items: T[], cursor: string | undefined, limit = Infinity): Page<T> {
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + Math.min(limit, this.pageSize);
    return end < items.length
      ? { items: items.slice(start, end), hasMore: true, nextCursor: String(end) }
      : { items: items.slice(start), hasMore: false };
  }

  async getChat(chatId: string): Promise<Chat> {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) throw new NotFoundError(`no chat ${chatId}`);
    return chat;
  }

  /** Newest first, as the port promises; past `pageSize`, older messages are on later pages. */
  async listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    const items = this.messages
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return this.page(items, query?.cursor);
  }

  async searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    let items = this.messages;
    if (query.query) {
      const q = query.query.toLowerCase();
      items = items.filter((m) => m.text?.toLowerCase().includes(q));
    }
    return { items, hasMore: false };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.sent.push(input);
    return { chatId: input.chatId, pendingMessageId: `pending-${this.sent.length}` };
  }

  async markChatRead(chatId: string): Promise<void> {
    this.markedRead.push(chatId);
  }
}
