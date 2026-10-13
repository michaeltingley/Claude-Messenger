import type { Messenger } from '../src/core/messenger.js';
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

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    accountId: 'whatsapp-1',
    senderId: 'alice',
    senderName: 'Alice',
    isFromMe: false,
    timestamp: '2026-07-10T00:00:00Z',
    text: 'hello',
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

/** What reaches an open watch: a message arriving, or the backend failing. */
type WatchEvent = { message: Message } | { error: Error };

/**
 * In-memory Messenger for tests: seed chats/messages, records sends. Messages
 * reach open watches through arrive(), and fail() makes the backend fail them.
 */
export class FakeMessenger implements Messenger {
  chats: Chat[] = [];
  messages: Message[] = [];
  sent: SendMessageInput[] = [];
  markedRead: string[] = [];
  /** Every watch opened, in order. */
  watchQueries: MessageWatchQuery[] = [];
  private readonly watchers = new Set<(event: WatchEvent) => void>();

  /** Watches still open: neither aborted, ended by the caller, nor failed. */
  get openWatches(): number {
    return this.watchers.size;
  }

  /** A message reaching the backend, as open watches see it arrive. */
  arrive(message: Message): void {
    this.messages.push(message);
    for (const push of this.watchers) push({ message });
  }

  /** The backend failing: every open watch ends with this error. */
  fail(error: Error): void {
    for (const push of this.watchers) push({ error });
  }

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
    return { items, hasMore: false };
  }

  async getChat(chatId: string): Promise<Chat> {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) throw new NotFoundError(`no chat ${chatId}`);
    return chat;
  }

  async listMessages(chatId: string, _query?: MessageListQuery): Promise<Page<Message>> {
    return { items: this.messages.filter((m) => m.chatId === chatId), hasMore: false };
  }

  async searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    let items = this.messages;
    if (query.query) {
      const q = query.query.toLowerCase();
      items = items.filter((m) => m.text?.toLowerCase().includes(q));
    }
    return { items, hasMore: false };
  }

  /** Catches up on matching messages already here, oldest first, then follows arrive(). */
  async *watchMessages(query: MessageWatchQuery, signal: AbortSignal): AsyncGenerator<Message, void, undefined> {
    this.watchQueries.push(query);
    const after = Date.parse(query.since);
    const matches = (m: Message) => m.isFromMe && Date.parse(m.timestamp) > after;
    const queue: WatchEvent[] = this.messages
      .filter(matches)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((message) => ({ message }));
    let wake: (() => void) | undefined;
    const push = (event: WatchEvent) => {
      queue.push(event);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.watchers.add(push);
    signal.addEventListener('abort', onAbort);
    try {
      while (!signal.aborted) {
        const event = queue.shift();
        if (event === undefined) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        if ('error' in event) throw event.error;
        if (matches(event.message)) yield event.message;
      }
    } finally {
      this.watchers.delete(push);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.sent.push(input);
    return { chatId: input.chatId, pendingMessageId: `pending-${this.sent.length}` };
  }

  async markChatRead(chatId: string): Promise<void> {
    this.markedRead.push(chatId);
  }
}
