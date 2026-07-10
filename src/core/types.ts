/**
 * Provider-agnostic domain models.
 *
 * Everything above the provider layer (policy, MCP tools, CLI, future
 * automations) depends on these types only — never on a provider SDK's
 * types. Providers translate their wire formats into these.
 */

export interface Account {
  id: string;
  /** Network identifier, e.g. "whatsapp", "signal", "imessage". */
  network: string;
  user: Participant;
}

export interface Participant {
  id: string;
  fullName?: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  isSelf?: boolean;
}

export type ChatType = 'single' | 'group';

export interface Chat {
  id: string;
  accountId: string;
  network: string;
  type: ChatType;
  title: string;
  unreadCount: number;
  participants: Participant[];
  /** True when the participant list was truncated by the provider. */
  participantsTruncated?: boolean;
  isArchived?: boolean;
  isMuted?: boolean;
  isPinned?: boolean;
  isReadOnly?: boolean;
  /** ISO 8601 timestamp of the most recent activity. */
  lastActivity?: string;
}

export type AttachmentType = 'unknown' | 'img' | 'video' | 'audio';

export interface AttachmentSummary {
  type: AttachmentType;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  isVoiceNote?: boolean;
  isSticker?: boolean;
}

export interface Reaction {
  /** Emoji or provider-specific reaction key. */
  key: string;
  participantId: string;
}

export interface Message {
  id: string;
  chatId: string;
  accountId: string;
  senderId: string;
  senderName?: string;
  isFromMe: boolean;
  /** ISO 8601 timestamp. */
  timestamp: string;
  text?: string;
  attachments: AttachmentSummary[];
  reactions: Reaction[];
  isUnread?: boolean;
  isDeleted?: boolean;
  /** ID of the message this one replies to, if any. */
  replyToMessageId?: string;
}

/** Cursor-paginated result set. */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** Pass back as `cursor` to fetch the next (older) page. */
  nextCursor?: string;
}

export interface ServerInfo {
  appName: string;
  appVersion: string;
  baseUrl: string;
  /** Whether the provider allows connections from other devices. */
  remoteAccess?: boolean;
}

export interface ChatQuery {
  /** Free-text search over chat titles or participant names. */
  query?: string;
  type?: ChatType | 'any';
  accountIds?: string[];
  unreadOnly?: boolean;
  includeMuted?: boolean;
  inbox?: 'primary' | 'low-priority' | 'archive';
  /** ISO 8601 lower bound on last activity. */
  lastActivityAfter?: string;
  /** ISO 8601 upper bound on last activity. */
  lastActivityBefore?: string;
  limit?: number;
  cursor?: string;
}

export interface MessageListQuery {
  cursor?: string;
}

export interface MessageSearchQuery {
  /** Literal word search — exact words, any order. */
  query?: string;
  chatIds?: string[];
  accountIds?: string[];
  chatType?: ChatType;
  /** ISO 8601 datetime bounds. */
  dateAfter?: string;
  dateBefore?: string;
  mediaTypes?: Array<'any' | 'video' | 'image' | 'link' | 'file'>;
  includeMuted?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
}

export interface SendMessageResult {
  chatId: string;
  /**
   * Provisional ID assigned before the network confirms the send. Resolve it
   * via getMessage / message listing once delivered.
   */
  pendingMessageId: string;
}
