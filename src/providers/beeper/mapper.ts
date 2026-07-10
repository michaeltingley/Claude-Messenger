import type BeeperDesktop from '@beeper/desktop-api';
import type {
  Account,
  AttachmentSummary,
  Chat,
  Message,
  Participant,
  Reaction,
} from '../../core/types.js';

/** Pure translation from Beeper Client API wire types to domain models. */

type WireAccount = Awaited<ReturnType<BeeperDesktop['accounts']['list']>>[number];
type WireChat = BeeperDesktop.Chat;
type WireMessage = BeeperDesktop.Message;

export function toAccount(a: WireAccount): Account {
  return {
    id: a.accountID,
    network: a.network ?? a.bridge.type,
    user: toParticipant(a.user),
  };
}

function toParticipant(u: {
  id: string;
  fullName?: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  isSelf?: boolean;
}): Participant {
  return {
    id: u.id,
    ...(u.fullName !== undefined && { fullName: u.fullName }),
    ...(u.username !== undefined && { username: u.username }),
    ...(u.phoneNumber !== undefined && { phoneNumber: u.phoneNumber }),
    ...(u.email !== undefined && { email: u.email }),
    ...(u.isSelf !== undefined && { isSelf: u.isSelf }),
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
    participants: c.participants.items.map(toParticipant),
    ...(c.participants.hasMore && { participantsTruncated: true }),
    ...(c.isArchived !== undefined && { isArchived: c.isArchived }),
    ...(c.isMuted !== undefined && { isMuted: c.isMuted }),
    ...(c.isPinned !== undefined && { isPinned: c.isPinned }),
    ...(c.isReadOnly !== undefined && { isReadOnly: c.isReadOnly }),
    ...(c.lastActivity !== undefined && { lastActivity: c.lastActivity }),
  };
}

function toAttachment(a: NonNullable<WireMessage['attachments']>[number]): AttachmentSummary {
  return {
    type: a.type,
    ...(a.fileName !== undefined && { fileName: a.fileName }),
    ...(a.mimeType !== undefined && { mimeType: a.mimeType }),
    ...(a.fileSize !== undefined && { fileSize: a.fileSize }),
    ...(a.isVoiceNote !== undefined && { isVoiceNote: a.isVoiceNote }),
    ...(a.isSticker !== undefined && { isSticker: a.isSticker }),
  };
}

function toReaction(r: NonNullable<WireMessage['reactions']>[number]): Reaction {
  return { key: r.reactionKey, participantId: r.participantID };
}

export function toMessage(m: WireMessage): Message {
  return {
    id: m.id,
    chatId: m.chatID,
    accountId: m.accountID,
    senderId: m.senderID,
    isFromMe: m.isSender ?? false,
    timestamp: m.timestamp,
    attachments: (m.attachments ?? []).map(toAttachment),
    reactions: (m.reactions ?? []).map(toReaction),
    ...(m.senderName !== undefined && { senderName: m.senderName }),
    ...(m.text !== undefined && { text: m.text }),
    ...(m.isUnread !== undefined && { isUnread: m.isUnread }),
    ...(m.isDeleted !== undefined && { isDeleted: m.isDeleted }),
    ...(m.linkedMessageID !== undefined && { replyToMessageId: m.linkedMessageID }),
  };
}
