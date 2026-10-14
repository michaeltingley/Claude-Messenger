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
  /** Unread messages that mention the account's user, or everyone in the chat. */
  unreadMentionsCount?: number;
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

/**
 * What a message is. A reaction, a notice or a sticker is not something a
 * person wrote, which matters to anything that acts on what was said.
 * 'other' is a kind this app does not know yet.
 */
export type MessageKind =
  | 'text'
  | 'notice'
  | 'image'
  | 'video'
  | 'voice'
  | 'audio'
  | 'file'
  | 'sticker'
  | 'location'
  | 'reaction'
  | 'other';

export interface Message {
  id: string;
  chatId: string;
  accountId: string;
  senderId: string;
  senderName?: string;
  isFromMe: boolean;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Left out when the provider doesn't say. */
  kind?: MessageKind;
  /**
   * What the message says, as plain text, as the chat shows it: no markup,
   * and not the copy of the message it answers that a reply can carry.
   * Empty when it says nothing in words, as a photo or a reaction can.
   */
  text: string;
  /**
   * The message as the provider gives it, read as HTML, when its plain text
   * leaves something out: markup, such as where its links point, or the
   * copy of the message a reply answers.
   */
  html?: string;
  /**
   * What the sender wrote in this message themselves, as plain text, read
   * cautiously: anything that may be someone else's words is left out, such
   * as the copy of another message a reply carries, a quoted passage, or the
   * name in a link to a person, which that person chose. So it can miss some
   * of the sender's own words too: it is for deciding whether they addressed
   * someone, not a stand-in for `text`. What the text can't tell apart, such
   * as a message they forward, reads as theirs. Left out when the provider
   * has no text for the message.
   */
  ownText?: string;
  attachments: AttachmentSummary[];
  reactions: Reaction[];
  isUnread?: boolean;
  isDeleted?: boolean;
  /** Kept out of the chat's normal display by the provider. */
  isHidden?: boolean;
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
  /** The most to return. A page may hold fewer while more remain, with `nextCursor` to the rest. */
  limit?: number;
  cursor?: string;
}

/**
 * Which messages a watch delivers. Only the user's own messages for now:
 * other senders are added with the first watch that needs them.
 */
export interface MessageWatchQuery {
  sender: 'me';
  /** ISO 8601: deliver only messages timestamped strictly after this. */
  since: string;
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
