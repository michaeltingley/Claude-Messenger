import type { AttachmentSummary, Chat, Message, MessageKind } from '../core/types.js';
import type { Activity, ChatActivity } from './activity.js';
import { formatDateTime, formatTime } from './time.js';

export interface BriefingOptions {
  /** The IANA time zone the owner reads times in. */
  timeZone: string;
}

/** What the model reads, and how much of the activity it holds. */
export interface Briefing {
  text: string;
  /** Chats it holds. */
  chats: number;
  /** Messages it holds from inside the window. */
  messages: number;
  /** Chats with messages that didn't fit in it. */
  leftOut: number;
}

/** A message's text is cut past this. */
const MAX_TEXT_CHARS = 1_000;
/** A chat's title, a name or a file name is cut past this. */
const MAX_NAME_CHARS = 100;
/** The longest a briefing gets, so a flood of messages can't make it endless. */
const MAX_BRIEFING_CHARS = 200_000;

/**
 * The briefing a digest is written from: plain text, one line per message,
 * times in the owner's time zone, the chats most likely to need the owner
 * first, so a briefing cut for length loses the least.
 *
 * Titles, names and messages are other people's words, so each is folded
 * onto one line: none can pass itself off as a line of the briefing's own,
 * such as a chat's heading or another message.
 */
export function renderBriefing(activity: Activity, { timeZone }: BriefingOptions): Briefing {
  const lines = [
    `It is ${formatDateTime(activity.window.until, timeZone)} in ${timeZone}, the time zone of every time below.`,
    `These are the chats with messages since ${formatDateTime(activity.window.since, timeZone)}.`,
  ];
  let length = lines.join('\n').length;
  let chats = 0;
  let messages = 0;
  let leftOut = 0;
  for (const chat of [...activity.chats].sort(byPriority)) {
    const block = renderChat(chat, timeZone);
    if (length + block.length + 2 > MAX_BRIEFING_CHARS) {
      leftOut++;
      continue;
    }
    lines.push('', block);
    length += block.length + 2;
    chats++;
    messages += chat.messages.length;
  }
  return { text: lines.join('\n'), chats, messages, leftOut };
}

function renderChat(activity: ChatActivity, timeZone: string): string {
  const { chat } = activity;
  const lines = [`## ${oneLine(chat.title, MAX_NAME_CHARS)}`, facts(activity).join(' · ')];
  if (activity.earlier.length > 0) {
    lines.push('Before then:', ...activity.earlier.map((m) => renderMessage(m, chat, timeZone)));
    lines.push('Since then:');
  }
  if (activity.truncated) lines.push('(Older messages from this window are left out.)');
  lines.push(...activity.messages.map((m) => renderMessage(m, chat, timeZone)));
  return lines.join('\n');
}

function facts({ chat, messages }: ChatActivity): string[] {
  const facts = [oneLine(chat.network, MAX_NAME_CHARS)];
  if (chat.type === 'single') facts.push('direct chat');
  else facts.push(chat.participantsTruncated ? 'large group' : `group of ${chat.participants.length}`);
  if (chat.unreadCount > 0) facts.push(`${chat.unreadCount} unread`);
  const mentions = chat.unreadMentionsCount ?? 0;
  if (mentions > 0) facts.push(`${mentions} unread mentioning you`);
  if (chat.isMuted) facts.push('muted');
  facts.push(`last message from ${sender(messages.at(-1)!, chat)}`);
  return facts;
}

function renderMessage(message: Message, chat: Chat, timeZone: string): string {
  const at = formatTime(new Date(message.timestamp), timeZone);
  const labels = describe(message);
  const text = message.text === undefined ? '' : oneLine(plainText(message.text), MAX_TEXT_CHARS);
  return (
    `- ${at} ${sender(message, chat)}` +
    (labels.length > 0 ? ` [${labels.join(', ')}]` : '') +
    (text ? `: ${text}` : '') +
    reactions(message, chat)
  );
}

function sender(message: Message, chat: Chat): string {
  if (message.isFromMe) return 'You';
  const name =
    message.senderName ??
    nameOf(chat, message.senderId) ??
    // In a direct chat, whoever isn't the owner is the chat.
    (chat.type === 'single' ? chat.title : undefined);
  return name === undefined ? 'Someone' : oneLine(name, MAX_NAME_CHARS);
}

function nameOf(chat: Chat, participantId: string): string | undefined {
  const participant = chat.participants.find((p) => p.id === participantId);
  return participant?.fullName ?? participant?.username;
}

/** What a message is, when it is more than its text. */
const KIND_LABELS: Partial<Record<MessageKind, string>> = {
  notice: 'automated',
  reaction: 'reaction',
  location: 'location',
  sticker: 'sticker',
  other: "a kind of message this app can't show",
};

/** What its attachments' kinds say, for a message the provider gave no attachments for. */
const MEDIA_LABELS: Partial<Record<MessageKind, string>> = {
  image: 'photo',
  video: 'video',
  voice: 'voice note',
  audio: 'audio',
  file: 'file',
};

function describe(message: Message): string[] {
  const labels: string[] = [];
  const kind = message.kind === undefined ? undefined : KIND_LABELS[message.kind];
  if (kind !== undefined) labels.push(kind);
  if (message.attachments.length > 0) labels.push(...message.attachments.map(attachment));
  else if (message.kind !== undefined && MEDIA_LABELS[message.kind] !== undefined) labels.push(MEDIA_LABELS[message.kind]!);
  return [...new Set(labels)];
}

function attachment(a: AttachmentSummary): string {
  if (a.isSticker) return 'sticker';
  if (a.isVoiceNote) return 'voice note';
  switch (a.type) {
    case 'img':
      return 'photo';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'unknown':
      return a.fileName ? `file "${oneLine(a.fileName, MAX_NAME_CHARS).replaceAll('"', "'")}"` : 'file';
  }
}

function reactions(message: Message, chat: Chat): string {
  if (message.reactions.length === 0) return '';
  const who = (id: string) =>
    chat.participants.find((p) => p.id === id)?.isSelf ? 'You' : oneLine(nameOf(chat, id) ?? 'someone', MAX_NAME_CHARS);
  const each = message.reactions.map((r) => `${oneLine(r.key, MAX_NAME_CHARS)} from ${who(r.participantId)}`);
  return ` (reactions: ${each.join(', ')})`;
}

/**
 * Message text without its formatting. Text can be HTML (Matrix's subset,
 * as Beeper sends it): a reply then carries a copy of the message it answers
 * (<mx-reply>), which the briefing already has or doesn't need. Only
 * HTML-shaped tags are dropped, so plain text keeps a "<3" or "a < b > c".
 */
function plainText(text: string): string {
  return text
    .replace(/<mx-reply\b[^>]*>[\s\S]*?<\/mx-reply>/gi, ' ')
    .replace(/<\/?(?:br|p|div|li|ul|ol|blockquote|pre|h[1-6]|tr)\b[^<>]*>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, decodeEntity);
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeEntity(entity: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
  const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/** Folds any run of whitespace, line breaks included, into one space, and cuts what runs past `max`. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The chats most likely to need the owner first: a mention, or a direct question waiting; muted chats last. */
function byPriority(a: ChatActivity, b: ChatActivity): number {
  return tier(a) - tier(b) || Date.parse(b.messages.at(-1)!.timestamp) - Date.parse(a.messages.at(-1)!.timestamp);
}

function tier({ chat, messages }: ChatActivity): number {
  const waiting = !messages.at(-1)!.isFromMe && chat.unreadCount > 0;
  if ((chat.unreadMentionsCount ?? 0) > 0 || waiting) return 0;
  return chat.isMuted ? 2 : 1;
}
