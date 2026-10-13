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
  checkConnection(): Promise<ServerInfo>;

  /** Connected chat-network accounts (WhatsApp, Signal, ...). */
  listAccounts(): Promise<Account[]>;

  /** Search / list chats. An empty query returns recent chats. */
  searchChats(query?: ChatQuery): Promise<Page<Chat>>;

  getChat(chatId: string): Promise<Chat>;

  /** Messages in one chat, newest first. */
  listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>>;

  /** Word search across chats/accounts. */
  searchMessages(query: MessageSearchQuery): Promise<Page<Message>>;

  /**
   * Messages matching `query` as they reach the backend, each delivered once,
   * oldest first within what arrives together. It first catches up on
   * matches already there after `query.since`. A message can reach the
   * backend late (a bridge reconnecting, a backlog syncing), so delivery
   * follows arrival, not strict timestamp order; how late a message may
   * arrive and still be delivered is the implementation's to state.
   *
   * The iterable ends when `signal` aborts, and ends with the error when the
   * backend fails: no retries, so the caller decides how to resume.
   */
  watchMessages(query: MessageWatchQuery, signal: AbortSignal): AsyncIterable<Message>;

  /** Send a message as the user. Implementations must treat this as real. */
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /** Mark a chat read as the user. */
  markChatRead(chatId: string): Promise<void>;
}
