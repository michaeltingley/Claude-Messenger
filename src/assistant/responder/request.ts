import type { Chat, Message } from '../../core/types.js';
import { MAX_NAME_CHARS, oneLine, quoted, renderMessage, type Speakers } from '../text/lines.js';
import { clockAt, formatDateTime } from '../text/time.js';
import type { Conversation } from './conversation.js';

/** A message of the owner's that asks the assistant something, with what it is answered from. */
export interface Request {
  /** The owner's message, as it stands. */
  message: Message;
  /** The chat it is in, as the owner's messenger shows it. */
  chat: Chat;
  /** The chat's messages from before it, oldest first. */
  earlier: Message[];
}

/**
 * What the model answers a request from: the time, the chat the request is
 * in and its latest messages, then the request itself. Messages are laid
 * out as `lines.ts` lays them out, the owner named "The owner" and the
 * assistant "You", so nothing anyone wrote can pass for either of them; and
 * each message is one line, under a heading that only the layout writes
 * unquoted, so none can pass for the request. Times are in `timeZone`.
 */
export function renderRequest({ message, chat, earlier }: Request, conversation: Conversation, now: Date, timeZone: string): string {
  const speakers: Speakers = { owner: 'The owner', others: new Map([[conversation.assistantUserId, 'You']]) };
  const clock = clockAt(now, timeZone);
  const line = (m: Message) => renderMessage(m, chat, clock, speakers);
  const heading =
    chat.id === conversation.chatId
      ? ['## Your chat with the owner']
      : [`## ${quoted(chat.title) ?? 'A chat with no name'}`, facts(chat)];
  return [
    `It is ${formatDateTime(now, timeZone, { year: true })} in ${timeZone}, the time zone of every time below.`,
    '',
    ...heading,
    // Not "none": a chat that moved on past what is read has earlier messages that aren't shown.
    ...(earlier.length > 0 ? earlier.map(line) : ['(No earlier messages shown.)']),
    '',
    "## The owner's message to you",
    line(message),
  ].join('\n');
}

function facts(chat: Chat): string {
  const size =
    chat.type === 'single' ? 'direct chat' : chat.participantsTruncated ? 'large group' : `group of ${chat.participants.length}`;
  return `${oneLine(chat.network, MAX_NAME_CHARS)} · ${size}`;
}
