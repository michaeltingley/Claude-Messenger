import type { AttachmentSummary, Chat, Message, MessageKind } from '../../core/types.js';
import type { Activity, ChatActivity } from './activity.js';
import { withoutInvisible } from './characters.js';
import { formatDateTime, formatTime, yearOf } from './time.js';

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
/** A message's attachments and reactions are each listed up to this many, then counted. */
const MAX_LISTED = 5;
/**
 * The longest a briefing gets, so a flood of messages can't make it endless.
 * With the limits above and the collector's default limits, one chat's block
 * always fits.
 */
const MAX_BRIEFING_CHARS = 200_000;
/** Within six days before now, a weekday names one day; further back, a time needs its date. */
const WEEKDAY_SPAN_MS = 6 * 24 * 3_600_000;

/** How a line gives a message's time. */
type Clock = (date: Date) => string;

/**
 * The briefing a digest is written from: plain text, one line per message,
 * times in the owner's time zone, the chats most likely to need the owner
 * first, so a briefing cut for length loses the least.
 *
 * Titles, names and messages are other people's words, so each is folded
 * onto one line, with no control or invisible characters: none can pass
 * itself off as a line of the briefing's own, such as a chat's heading or
 * another message. Other people's names and every reaction are always in
 * quotes, which they can't hold, so none can pass for the owner, whom the
 * briefing alone calls You, however it is written.
 */
export function renderBriefing(activity: Activity, timeZone: string): Briefing {
  const { since, until } = activity.window;
  const clock: Clock = (date) => {
    if (until.getTime() - date.getTime() < WEEKDAY_SPAN_MS) return formatTime(date, timeZone);
    return formatDateTime(date, timeZone, { year: yearOf(date, timeZone) !== yearOf(until, timeZone) });
  };
  const lines = [
    `It is ${formatDateTime(until, timeZone, { year: true })} in ${timeZone}, the time zone of every time below.`,
    `These are the chats with messages since ${formatDateTime(since, timeZone)}.`,
  ];
  let length = lines.join('\n').length;
  let chats = 0;
  let messages = 0;
  let leftOut = 0;
  for (const chat of [...activity.chats].sort(byPriority)) {
    const block = renderChat(chat, clock);
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

function renderChat(activity: ChatActivity, clock: Clock): string {
  const { chat } = activity;
  const lines = [`## ${oneLine(chat.title, MAX_NAME_CHARS)}`, facts(activity).join(' · ')];
  if (activity.earlier.length > 0) {
    lines.push('Before then:', ...activity.earlier.map((m) => renderMessage(m, chat, clock)));
    lines.push('Since then:');
  }
  if (activity.truncated) lines.push('(Older messages from this window are left out.)');
  lines.push(...activity.messages.map((m) => renderMessage(m, chat, clock)));
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

function renderMessage(message: Message, chat: Chat, clock: Clock): string {
  const labels = describe(message);
  const text = oneLine(message.text, MAX_TEXT_CHARS);
  return (
    `- ${clock(new Date(message.timestamp))} ${sender(message, chat)}` +
    (labels.length > 0 ? ` [${labels.join(', ')}]` : '') +
    (text ? `: ${text}` : '') +
    reactions(message, chat)
  );
}

function sender(message: Message, chat: Chat): string {
  if (message.isFromMe) return 'You';
  return (
    quoted(message.senderName) ??
    quoted(nameOf(chat, message.senderId)) ??
    // In a direct chat, whoever isn't the owner is the chat.
    (chat.type === 'single' ? quoted(chat.title) : undefined) ??
    'Someone'
  );
}

function nameOf(chat: Chat, participantId: string): string | undefined {
  const participant = chat.participants.find((p) => p.id === participantId);
  return participant?.fullName ?? participant?.username;
}

/**
 * What reads as a double quote mark: quotes, primes, ditto marks and their
 * ornaments. Words in quotes lose them, so that they can't end their quotes
 * early.
 */
const QUOTE_MARKS = /["“”„‟″‶＂ˮʺ˝״〃〝〞〟❝❞❠⹂🙶🙷🙸]/gu;

/**
 * Words someone chose, such as a name for themselves or a chat, or a
 * reaction, as a line shows them: on one line and in quotes, so they read as
 * theirs and nobody else's. Nothing when there's nothing to show.
 */
function quoted(words: string | undefined): string | undefined {
  if (words === undefined) return undefined;
  const shown = oneLine(words.replace(QUOTE_MARKS, ''), MAX_NAME_CHARS);
  return shown === '' ? undefined : `"${shown}"`;
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
  return listed([...new Set(labels)], 'more attachments');
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
    default:
      return a.fileName ? `file "${oneLine(a.fileName.replace(QUOTE_MARKS, "'"), MAX_NAME_CHARS)}"` : 'file';
  }
}

function reactions(message: Message, chat: Chat): string {
  if (message.reactions.length === 0) return '';
  // In a direct chat, whoever isn't the owner is the chat, once it is known who the owner is.
  const knowsOwner = chat.participants.some((p) => p.isSelf);
  const who = (id: string) => {
    if (chat.participants.find((p) => p.id === id)?.isSelf) return 'You';
    return (
      quoted(nameOf(chat, id)) ??
      (chat.type === 'single' && knowsOwner ? quoted(chat.title) : undefined) ??
      'someone'
    );
  };
  const each = message.reactions.map((r) => `${quoted(r.key) ?? 'a reaction'} from ${who(r.participantId)}`);
  return ` (reactions: ${listed(each, 'more').join(', ')})`;
}

/** The first few items, then how many more there are. */
function listed(items: string[], more: string): string[] {
  return items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `${items.length - MAX_LISTED} ${more}`] : items;
}

/**
 * Folds any run of whitespace or line breaks, NEL included, into one space,
 * drops control and invisible characters, and cuts what runs past `max`,
 * never through the middle of a character.
 */
function oneLine(text: string, max: number): string {
  const line = withoutInvisible(text).replace(/[\s\u0085]+/g, ' ').trim();
  if (line.length <= max) return line;
  const end = /[\ud800-\udbff]/.test(line[max - 1]!) ? max - 1 : max;
  return `${line.slice(0, end)}…`;
}

/** The chats most likely to need the owner first: a mention, or a direct chat waiting on them; muted chats last. */
function byPriority(a: ChatActivity, b: ChatActivity): number {
  return tier(a) - tier(b) || Date.parse(b.messages.at(-1)!.timestamp) - Date.parse(a.messages.at(-1)!.timestamp);
}

function tier({ chat, messages }: ChatActivity): number {
  if ((chat.unreadMentionsCount ?? 0) > 0) return 0;
  if (chat.isMuted) return 2;
  const waiting = chat.type === 'single' && chat.unreadCount > 0 && !messages.at(-1)!.isFromMe;
  return waiting ? 0 : 1;
}
