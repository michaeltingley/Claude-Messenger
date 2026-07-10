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

// Streaming (Beeper's WebSocket events, Matrix /sync) is a planned extension.
// It will be added to this port together with its first provider
// implementation AND a guarded wrapper, so pushed events pass through the
// same visibility filtering and audit as pulled reads — never as a raw
// provider capability reachable around the policy layer.
