import { type Clock, MAX_NAME_CHARS, oneLine, quoted, renderMessage, sender, type Speakers } from '../text/lines.js';
import { clockAt, formatDateTime } from '../text/time.js';
import type { Activity, ChatActivity } from './activity.js';

/** What the model reads, and how much of the activity it holds. */
export interface Briefing {
  text: string;
  /** Chats it holds. */
  chats: number;
  /** Messages it holds from inside the window. */
  messages: number;
  /** Chats it holds with older messages from the window left out of what was read. */
  partial: number;
  /** Chats with messages that didn't fit in it. */
  leftOut: number;
}

/**
 * The longest a briefing gets, so a flood of messages can't make it endless.
 * With the limits on each part of a line (`lines.ts`) and the collector's
 * default limits, one chat's block always fits.
 */
const MAX_BRIEFING_CHARS = 200_000;

/** The digest is written to the owner, so the briefing calls them You. */
const SPEAKERS: Speakers = { owner: 'You' };

/**
 * The briefing a digest is written from: plain text, one line per message,
 * times in the owner's time zone, the chats most likely to need the owner
 * first, so a briefing cut for length loses the least. Each chat is under a
 * heading of its own, and each message on a line laid out as `lines.ts`
 * says, so that nothing anyone wrote can pass for a heading, another
 * message, or the owner, whom the briefing alone calls You.
 */
export function renderBriefing(activity: Activity, timeZone: string): Briefing {
  const { since, until } = activity.window;
  const clock = clockAt(until, timeZone);
  const lines = [
    `It is ${formatDateTime(until, timeZone, { year: true })} in ${timeZone}, the time zone of every time below.`,
    `These are the chats with messages since ${formatDateTime(since, timeZone)}.`,
  ];
  let length = lines.join('\n').length;
  let chats = 0;
  let messages = 0;
  let partial = 0;
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
    if (chat.truncated) partial++;
  }
  return { text: lines.join('\n'), chats, messages, partial, leftOut };
}

function renderChat(activity: ChatActivity, clock: Clock): string {
  const { chat } = activity;
  const lines = [`## ${quoted(chat.title) ?? 'A chat with no name'}`, facts(activity).join(' · ')];
  if (activity.earlier.length > 0) {
    lines.push('Before then:', ...activity.earlier.map((m) => renderMessage(m, chat, clock, SPEAKERS)));
    lines.push('Since then:');
  }
  if (activity.truncated) lines.push('(Older messages from this window are left out.)');
  lines.push(...activity.messages.map((m) => renderMessage(m, chat, clock, SPEAKERS)));
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
  facts.push(`last message from ${sender(messages.at(-1)!, chat, SPEAKERS)}`);
  return facts;
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
