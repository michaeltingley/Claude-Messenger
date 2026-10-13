import type BeeperDesktop from '@beeper/desktop-api';
import type {
  Account,
  AttachmentSummary,
  Chat,
  Message,
  MessageKind,
  Page,
  Participant,
  Reaction,
} from '../../core/types.js';
import { plainText } from './plain-text.js';

/** Pure translation from Beeper Client API wire types to domain models. */

type WireAccount = Awaited<ReturnType<BeeperDesktop['accounts']['list']>>[number];
type WireChat = BeeperDesktop.Chat;
type WireMessage = BeeperDesktop.Message;

/** Shape shared by the SDK's CursorSearch and CursorNoLimit pages. */
interface WirePage<W> {
  items: W[];
  hasMore: boolean;
  oldestCursor: string | null;
}

/**
 * `oldestCursor` fed back as `cursor` fetches the next (older) page — this
 * mirrors the SDK's own nextPageRequestOptions().
 */
export function toPage<W, T>(page: WirePage<W>, map: (wire: W) => T): Page<T> {
  return {
    items: page.items.map(map),
    hasMore: page.hasMore,
    ...(page.oldestCursor !== null && { nextCursor: page.oldestCursor }),
  };
}

export function toAccount(a: WireAccount): Account {
  return {
    id: a.accountID,
    // `bridge` only exists on Beeper Desktop v4.2.785+ and `network` may be
    // omitted for unknown networks — degrade instead of crashing.
    network: a.network ?? a.bridge?.type ?? 'unknown',
    user: toParticipant(a.user),
  };
}

function toParticipant(u: WireChat['participants']['items'][number] | WireAccount['user']): Participant {
  return {
    id: u.id,
    fullName: u.fullName,
    username: u.username,
    phoneNumber: u.phoneNumber,
    email: u.email,
    isSelf: u.isSelf,
  };
}

export function toChat(c: WireChat): Chat {
  return {
    id: c.id,
    accountId: c.accountID,
    network: c.network,
    type: c.type,
    title: c.title,
    unreadCount: c.unreadCount,
    unreadMentionsCount: c.unreadMentionsCount,
    participants: c.participants.items.map(toParticipant),
    participantsTruncated: c.participants.hasMore || undefined,
    isArchived: c.isArchived,
    isMuted: c.isMuted,
    isPinned: c.isPinned,
    isReadOnly: c.isReadOnly,
    lastActivity: c.lastActivity,
  };
}

function toAttachment(a: NonNullable<WireMessage['attachments']>[number]): AttachmentSummary {
  return {
    type: a.type,
    fileName: a.fileName,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    isVoiceNote: a.isVoiceNote,
    isSticker: a.isSticker,
  };
}

function toReaction(r: NonNullable<WireMessage['reactions']>[number]): Reaction {
  return { key: r.reactionKey, participantId: r.participantID };
}

/** The wire's message types, by this app's names for them. */
const KINDS = new Map<string, MessageKind>(
  Object.entries({
    TEXT: 'text',
    NOTICE: 'notice',
    IMAGE: 'image',
    VIDEO: 'video',
    VOICE: 'voice',
    AUDIO: 'audio',
    FILE: 'file',
    STICKER: 'sticker',
    LOCATION: 'location',
    REACTION: 'reaction',
  } satisfies Record<NonNullable<WireMessage['type']>, MessageKind>),
);

/** A type newer than this app is 'other', so nothing mistakes it for text. */
function toKind(type: string | undefined): MessageKind | undefined {
  return type === undefined ? undefined : (KINDS.get(type) ?? 'other');
}

/**
 * Newest first, as the domain's pages run: by time, then, for messages sent
 * the same moment, by the sort key Beeper orders a chat by.
 */
export function newestFirst(a: WireMessage, b: WireMessage): number {
  const time = (m: WireMessage) => Date.parse(m.timestamp) || 0;
  return time(b) - time(a) || (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0);
}

/**
 * A message's words as the chat shows them, and the HTML they came from when
 * there is markup in it. Beeper's `text` is a message's HTML formatted body
 * when it has one, else its plain body, and doesn't say which.
 */
function readable(text: string | undefined): Pick<Message, 'text' | 'html'> {
  if (text === undefined) return { text: '' };
  const shown = plainText(text);
  return shown === text.trim() ? { text: shown } : { text: shown, html: text };
}

export function toMessage(m: WireMessage): Message {
  return {
    id: m.id,
    chatId: m.chatID,
    accountId: m.accountID,
    senderId: m.senderID,
    senderName: m.senderName,
    isFromMe: m.isSender ?? false,
    timestamp: m.timestamp,
    kind: toKind(m.type),
    ...readable(m.text),
    attachments: (m.attachments ?? []).map(toAttachment),
    reactions: (m.reactions ?? []).map(toReaction),
    isUnread: m.isUnread,
    isDeleted: m.isDeleted,
    isHidden: m.isHidden,
    replyToMessageId: m.linkedMessageID,
  };
}
