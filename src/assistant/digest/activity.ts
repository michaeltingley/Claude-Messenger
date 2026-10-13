import { NotFoundError, PolicyDeniedError, ProviderError } from '../../core/errors.js';
import type { Messenger } from '../../core/messenger.js';
import type { Chat, Message } from '../../core/types.js';

/** The span of time a digest covers: after `since`, up to and including `until`. */
export interface DigestWindow {
  since: Date;
  until: Date;
}

/** One chat's messages in a window, as the digest reads them. */
export interface ChatActivity {
  chat: Chat;
  /** The window's messages, oldest first. */
  messages: Message[];
  /**
   * The last few messages from before the window, oldest first: what the
   * window's first messages answer, or a question that was already waiting.
   * None when the window was too busy to read in full, since they wouldn't
   * come right before what was read.
   */
  earlier: Message[];
  /** True when the window held more messages than were read: the oldest were left out. */
  truncated: boolean;
}

/** What a digest is written from. */
export interface Activity {
  window: DigestWindow;
  /** Chats with messages in the window, the most recent message first. */
  chats: ChatActivity[];
  /** How many chats with activity in the window could not be read. */
  unreadable: number;
  /**
   * How many chats had more in the window than was read, whether or not
   * anything read showed: their oldest messages are left out.
   */
  partial: number;
  /** True when more chats had activity than were read. */
  moreChats: boolean;
}

export interface ActivityLimits {
  /** The most chats to read. */
  chats: number;
  /** The most pages of the chat list to look through, however many chats a policy leaves out of them. */
  chatListPages: number;
  /** The most messages to keep from one chat's window: the newest. */
  messagesPerChat: number;
  /** How many messages from just before the window to keep, for context. */
  earlierMessages: number;
  /** The most pages of messages to read from one chat. */
  pagesPerChat: number;
}

export const DEFAULT_ACTIVITY_LIMITS: ActivityLimits = {
  chats: 40,
  chatListPages: 25,
  messagesPerChat: 40,
  earlierMessages: 3,
  pagesPerChat: 5,
};

/** Chats asked for per page of the chat list. */
const CHAT_PAGE_SIZE = 20;

/**
 * Reads what happened in a window: the chats in the owner's main inbox with
 * activity in it (not archived, not low priority), and their messages.
 *
 * It reads only as far back as it needs, and keeps only what shows in a
 * chat: no deleted or hidden messages, none with nothing in them. Handed the
 * `GuardedMessenger`, it reads only what the policy lets it, and every read
 * is audited, content left out.
 */
export class ActivityCollector {
  constructor(
    private readonly messenger: Messenger,
    private readonly limits: ActivityLimits = DEFAULT_ACTIVITY_LIMITS,
  ) {}

  async collect(window: DigestWindow): Promise<Activity> {
    const { chats, moreChats } = await this.activeChats(window);
    const read: ChatActivity[] = [];
    const failures: unknown[] = [];
    let partial = 0;
    for (const chat of chats) {
      let activity: ChatActivity;
      try {
        activity = await this.chatActivity(chat, window);
      } catch (err) {
        if (!concernsOneChat(err)) throw err;
        failures.push(err);
        continue;
      }
      if (activity.truncated) partial++;
      if (activity.messages.length > 0) read.push(activity);
    }
    // When no chat at all could be read, the cause is not any one chat's.
    if (failures.length > 0 && failures.length === chats.length) throw failures[0];
    read.sort((a, b) => latest(b) - latest(a));
    return { window, chats: read, unreadable: failures.length, partial, moreChats };
  }

  private async activeChats(window: DigestWindow): Promise<{ chats: Chat[]; moreChats: boolean }> {
    const page = (cursor?: string) =>
      this.messenger.searchChats({
        inbox: 'primary',
        lastActivityAfter: window.since.toISOString(),
        limit: CHAT_PAGE_SIZE,
        cursor,
      });
    // The list puts the latest activity first, so a chat that gets a message
    // while it is paged through moves up it. One that moves down a page as
    // others move up comes twice, and is read once.
    const found = new Map<string, Chat>();
    let pages = 0;
    let more = true;
    let cursor: string | undefined;
    while (more && found.size < this.limits.chats && pages < this.limits.chatListPages) {
      const { items, hasMore, nextCursor } = await page(cursor);
      pages++;
      for (const chat of items) if (!found.has(chat.id)) found.set(chat.id, chat);
      more = hasMore && nextCursor !== undefined;
      cursor = nextCursor;
    }
    let chats = [...found.values()];
    if (pages > 1) {
      // One that moved from a page not yet read to the top would be missed,
      // so the first page is read again, last. What is new on it has the
      // latest activity of all.
      const { items } = await page();
      chats = [...items.filter((chat) => !found.has(chat.id)), ...chats];
    }
    return { chats: chats.slice(0, this.limits.chats), moreChats: more || chats.length > this.limits.chats };
  }

  private async chatActivity(chat: Chat, window: DigestWindow): Promise<ChatActivity> {
    const since = window.since.getTime();
    const until = window.until.getTime();
    // Pages come newest first, each one older than the last.
    const inWindow: Message[] = [];
    const earlier: Message[] = [];
    let reachedStart = false;
    let truncated = false;
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      const { items, hasMore, nextCursor } = await this.messenger.listMessages(
        chat.id,
        cursor === undefined ? undefined : { cursor },
      );
      for (const message of items) {
        const at = Date.parse(message.timestamp);
        if (Number.isNaN(at) || at > until) continue;
        if (at <= since) reachedStart = true;
        if (!shows(message)) continue;
        if (at > since) {
          if (inWindow.length < this.limits.messagesPerChat) inWindow.push(message);
          else truncated = true;
        } else if (earlier.length < this.limits.earlierMessages) {
          earlier.push(message);
        }
      }
      if (truncated || (reachedStart && earlier.length >= this.limits.earlierMessages)) break;
      if (!hasMore || nextCursor === undefined) break;
      if (page === this.limits.pagesPerChat) {
        // Older messages are still inside the window, unread.
        truncated = !reachedStart;
        break;
      }
      cursor = nextCursor;
    }
    return { chat, messages: inWindow.reverse(), earlier: truncated ? [] : earlier.reverse(), truncated };
  }
}

/** Whether a message shows in its chat with something in it. */
function shows(message: Message): boolean {
  if (message.isDeleted || message.isHidden) return false;
  if (message.text.trim() || message.attachments.length > 0) return true;
  // A reaction, a sticker or a location can carry no text and still show.
  return message.kind !== undefined && message.kind !== 'text' && message.kind !== 'notice';
}

/**
 * Failures that are about one chat (it is gone, the provider failed on it,
 * the policy refuses it), so the rest of the digest can still be written.
 * Anything else (a lost connection, a rejected token, an audit log that
 * can't be written) stops the whole read.
 */
function concernsOneChat(err: unknown): err is NotFoundError | ProviderError | PolicyDeniedError {
  return err instanceof NotFoundError || err instanceof ProviderError || err instanceof PolicyDeniedError;
}

function latest(activity: ChatActivity): number {
  return Date.parse(activity.messages.at(-1)!.timestamp);
}
