import type { AttachmentSummary, Chat, Message, MessageKind } from '../../core/types.js';
import { withoutInvisible } from './characters.js';

/** A message's text is cut past this. */
const MAX_TEXT_CHARS = 1_000;
/** A chat's title, a name or a file name is cut past this. */
export const MAX_NAME_CHARS = 100;
/** A message's attachments and reactions are each listed up to this many, then counted. */
const MAX_LISTED = 5;

/** How a line gives a message's time. */
export type Clock = (date: Date) => string;

/**
 * Who the lines name without quotes, each by words of the reader's own: the
 * owner, and anyone else the reader knows by their user ID, such as the
 * assistant. Everyone else is named in quotes, as they named themselves.
 */
export interface Speakers {
  /** The owner: who sends the messages that are `isFromMe`, and the chat's `isSelf` participant. */
  owner: string;
  /** Anyone else named without quotes, by user ID. */
  others?: ReadonlyMap<string, string>;
}

/**
 * One message's line, as a model reads it: its time, who sent it, what it
 * is and its reactions, then its text.
 *
 * Titles, names and messages are other people's words, so each is folded
 * onto one line, with no control or invisible characters: none can pass
 * itself off as a line of the layout's own, such as a chat's heading or
 * another message. Chats' and other people's names and every reaction are
 * always in quotes, which they can't hold, so none can pass for the owner,
 * or anyone else the lines alone name without quotes (`Speakers`), however
 * it is written. A message's text comes last on its line, after everything
 * the line says of it, from the first colon outside quotes that follows its
 * sender, since nothing the line says of it holds one: so the text can't
 * pass for any of that, such as a reaction of the owner's, even where it
 * starts.
 */
export function renderMessage(message: Message, chat: Chat, clock: Clock, speakers: Speakers): string {
  const labels = describe(message);
  const text = oneLine(message.text, MAX_TEXT_CHARS);
  return (
    `- ${clock(new Date(message.timestamp))} ${sender(message, chat, speakers)}` +
    (labels.length > 0 ? ` [${labels.join(', ')}]` : '') +
    reactions(message, chat, speakers) +
    (text ? `: ${text}` : '')
  );
}

/** Who sent a message, as its line names them. */
export function sender(message: Message, chat: Chat, speakers: Speakers): string {
  if (message.isFromMe) return speakers.owner;
  return (
    speakers.others?.get(message.senderId) ??
    quoted(message.senderName) ??
    quoted(nameOf(chat, message.senderId)) ??
    // In a direct chat, whoever isn't the owner is the chat.
    (chat.type === 'single' ? quoted(chat.title) : undefined) ??
    'Someone'
  );
}

/** Whether a message shows in its chat with something in it, and so has a line. */
export function shows(message: Message): boolean {
  if (message.isDeleted || message.isHidden) return false;
  if (message.text.trim() || message.attachments.length > 0) return true;
  // A reaction, a sticker or a location can carry no text and still show.
  return message.kind !== undefined && message.kind !== 'text' && message.kind !== 'notice';
}

function nameOf(chat: Chat, participantId: string): string | undefined {
  const participant = chat.participants.find((p) => p.id === participantId);
  return participant?.fullName ?? participant?.username;
}

/**
 * What reads as a double quote mark: every quotation mark but the single
 * ones; what else Unicode lists as looking like a double one, or like
 * single ones side by side, such as primes and ditto marks; corner
 * brackets; and quote ornaments. A script's letters stay, though some look
 * alike, since they read as that script's. Words in quotes lose these, so
 * that they can't end their quotes early.
 */
const QUOTE_MARKS = /(?![‘’‛])[\p{Pi}\p{Pf}]|["“”„‟″‴‶‷⁗＂ˮʺ˝˵˶״\u1cd3〃〝〞〟「」『』﹁﹂﹃﹄｢｣❛❜❝❞❟❠❮❯⹂🙶🙷🙸]/gu;

/**
 * A run of combining marks on what isn't a word's letter that shows: a
 * space, a quote mark, a modifier letter (ʼ), or a letter that shows as
 * nothing, such as a Hangul filler. There, a mark shaped like a quote mark
 * reads as one; on a letter it is an accent, as "ő" can be written. A mark
 * on what shows as nothing counts as on nothing, since what is taken out
 * later, invisible characters, could leave it on a space. Each run is
 * matched whole, from its start, so this takes time linear in the text.
 */
const MARKS_ON_NO_LETTER = /(?<!(?![\p{Lm}\p{DI}])[\p{L}\p{M}])\p{M}+/gu;

/**
 * The marks shaped like a quote mark set over a character: an acute, a
 * grave, a comma above, each of them doubled, and the Hebrew accents shaped
 * so (a geresh, a gershayim). Two single ones read as a double one.
 */
const QUOTE_ACCENTS = /[\u0300\u0301\u030b\u030f\u0312-\u0315\u0340\u0341\u0343\u0344\u059c-\u059e]/g;

/**
 * A single quote mark, or what Unicode lists as looking like one, or as the
 * same as one (Greek's varia and oxia, its numeral sign), but isn't a
 * script's letter or mark, such as an apostrophe, a prime or an accent on
 * its own.
 */
const SINGLE_QUOTE = String.raw`['\u2018\u2019\u201a\u201b\u2032\u2035\u0060\u00b4\u02b9\u02bb\u02bc\u02bd\u02be\u02c8\u02ca\u02cb\u02f4\u0374\u0384\u055a\u055b\u055d\u05f3\u07f4\u07f5\u1fbd\u1fbf\u1fef\u1ffd\u1ffe\u2cff\uff07\uff40\u{1e94b}]`;

/**
 * Two or more single quote marks in a row, which read as a double one, with
 * nothing between them but what shows as nothing or sits on one of them.
 */
const SINGLE_QUOTES = new RegExp(String.raw`${SINGLE_QUOTE}(?:[\p{M}\p{DI}]*${SINGLE_QUOTE})+`, 'gu');

/**
 * Words someone chose, such as a name for themselves or a chat, or a
 * reaction, as a line shows them: on one line and in quotes, so they read as
 * theirs and nobody else's. Nothing when there's nothing to show.
 */
export function quoted(words: string | undefined): string | undefined {
  if (words === undefined) return undefined;
  const shown = oneLine(withoutQuoteMarks(words, ''), MAX_NAME_CHARS);
  return shown === '' ? undefined : `"${shown}"`;
}

/**
 * `words` with each double quote mark replaced and each run of single ones
 * made one: once nothing invisible is left that could hide one, or join the
 * halves of one when it goes. A run of single ones is made one last, so
 * that none is left that what goes before could have made.
 */
function withoutQuoteMarks(words: string, replacement: string): string {
  return withoutInvisible(words)
    .replace(QUOTE_MARKS, replacement)
    .replace(MARKS_ON_NO_LETTER, (marks) => marks.replace(QUOTE_ACCENTS, ''))
    .replace(SINGLE_QUOTES, "'");
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
      return a.fileName ? `file "${oneLine(withoutQuoteMarks(a.fileName, "'"), MAX_NAME_CHARS)}"` : 'file';
  }
}

function reactions(message: Message, chat: Chat, speakers: Speakers): string {
  if (message.reactions.length === 0) return '';
  // In a direct chat, whoever isn't the owner is the chat, once it is known who the owner is.
  const knowsOwner = chat.participants.some((p) => p.isSelf);
  const who = (id: string) => {
    if (chat.participants.find((p) => p.id === id)?.isSelf) return speakers.owner;
    return (
      speakers.others?.get(id) ??
      quoted(nameOf(chat, id)) ??
      (chat.type === 'single' && knowsOwner ? quoted(chat.title) : undefined) ??
      'someone'
    );
  };
  const each = message.reactions.map((r) => `${quoted(r.key) ?? 'a reaction'} from ${who(r.participantId)}`);
  return ` (reactions ${listed(each, 'more').join(', ')})`;
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
export function oneLine(text: string, max: number): string {
  const line = withoutInvisible(text).replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const end = /[\ud800-\udbff]/.test(line[max - 1]!) ? max - 1 : max;
  return `${line.slice(0, end)}…`;
}
