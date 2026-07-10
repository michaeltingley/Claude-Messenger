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
} from './types.js';

/**
 * The provider-agnostic port for a message backend.
 *
 * Implementations (Beeper Desktop API, Beeper Server, raw Matrix, fakes in
 * tests) translate these calls to their wire protocol. Every layer above —
 * policy, MCP tools, CLI, automations — programs against this interface and
 * must never import a provider directly.
 */
export interface Messenger {
  /** Identify the backend and confirm the connection + credentials work. */
  whoami(): Promise<ServerInfo>;

  /** Connected chat-network accounts (WhatsApp, Signal, ...). */
  listAccounts(): Promise<Account[]>;

  /** Search / list chats. An empty query returns recent chats. */
  searchChats(query?: ChatQuery): Promise<Page<Chat>>;

  getChat(chatId: string): Promise<Chat>;

  /** Messages in one chat, newest first. */
  listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>>;

  /** Word search across chats/accounts. */
  searchMessages(query: MessageSearchQuery): Promise<Page<Message>>;

  /** Send a message as the user. Implementations must treat this as real. */
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /** Mark a chat read as the user. */
  markChatRead(chatId: string): Promise<void>;
}

/**
 * Optional streaming extension: backends that can push new/updated messages
 * in real time (Beeper's WebSocket events, Matrix /sync) implement this too.
 * Automation triggers are built on it; polling is the fallback.
 */
export interface MessageStream {
  /**
   * Subscribe to message upserts. Returns an unsubscribe function.
   * `chatIds` of `['*']` (default) means all chats.
   */
  onMessage(handler: (message: Message) => void, chatIds?: string[]): Promise<() => void>;
}

export function supportsStreaming(m: Messenger): m is Messenger & MessageStream {
  return typeof (m as Partial<MessageStream>).onMessage === 'function';
}
