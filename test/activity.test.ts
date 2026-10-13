import { describe, expect, it } from 'vitest';
import { AuthError, ConnectionError, NotFoundError, ProviderError } from '../src/core/errors.js';
import type { Chat, ChatQuery, Message, MessageListQuery, Page } from '../src/core/types.js';
import { ActivityCollector, DEFAULT_ACTIVITY_LIMITS, type ActivityLimits } from '../src/assistant/digest/activity.js';
import { FakeMessenger, makeChat, makeMessage } from './fake-messenger.js';

const since = new Date('2026-10-12T14:46:00Z');
const until = new Date('2026-10-13T14:46:00Z');
const window = { since, until };

/** An ISO time `minutes` after the window opens (before it, when negative). */
const at = (minutes: number) => new Date(since.getTime() + minutes * 60_000).toISOString();

const activeChat = (id: string, overrides = {}) =>
  makeChat({ id, title: id, lastActivity: at(60), ...overrides });

const message = (id: string, chatId: string, minutes: number, overrides: Partial<Message> = {}) =>
  makeMessage({ id, chatId, timestamp: at(minutes), text: `text of ${id}`, ...overrides });

/**
 * A FakeMessenger that remembers which chats' messages were read, page by
 * page, and the cursor of each page of the chat list it was asked for.
 */
class CountingMessenger extends FakeMessenger {
  listed: string[] = [];
  searches: (string | undefined)[] = [];
  override listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    this.listed.push(chatId);
    return super.listMessages(chatId, query);
  }
  override searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    this.searches.push(query?.cursor);
    return super.searchChats(query);
  }
}

/** Gives `fake` the chats `ids`, most recently active first, as Beeper lists them, each with one message in the window. */
const listInOrder = (fake: FakeMessenger, ids: string[]) => {
  fake.chats = ids.map((id, n) => activeChat(id, { lastActivity: at(ids.length - n) }));
  fake.messages = ids.map((id, n) => message(`m-${id}`, id, ids.length - n));
};

/**
 * A CountingMessenger whose last chat gets a message once the first page of
 * chats is read, after the window, as the window ends when the digest
 * starts, and so moves to the top of the list.
 */
class Jumping extends CountingMessenger {
  override searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    if (this.searches.length === 1) {
      const moved = this.chats.at(-1)!;
      const late = message(`late-${moved.id}`, moved.id, 24 * 60 + 1);
      this.messages.push(late);
      this.chats = [{ ...moved, lastActivity: late.timestamp }, ...this.chats.slice(0, -1)];
    }
    return super.searchChats(query);
  }
}

const collector = (messenger: FakeMessenger, limits: Partial<ActivityLimits> = {}) =>
  new ActivityCollector(messenger, { ...DEFAULT_ACTIVITY_LIMITS, ...limits });

const ids = (messages: Message[]) => messages.map((m) => m.id);

describe('ActivityCollector', () => {
  it("reads the window's messages, oldest first, with the last few from before it for context", async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1')];
    fake.messages = [
      message('long-ago', 'c1', -3000),
      message('before-2', 'c1', -120),
      message('before-1', 'c1', -60),
      message('in-1', 'c1', 10),
      message('in-2', 'c1', 20),
    ];
    const activity = await collector(fake, { earlierMessages: 2 }).collect(window);
    expect(activity.chats).toHaveLength(1);
    expect(ids(activity.chats[0]!.messages)).toEqual(['in-1', 'in-2']);
    expect(ids(activity.chats[0]!.earlier)).toEqual(['before-2', 'before-1']);
    expect(activity.chats[0]!.truncated).toBe(false);
    expect(activity).toMatchObject({ window, unreadable: 0, partial: 0, moreChats: false });
  });

  it('reads only chats active in the window, in the main inbox', async () => {
    const fake = new CountingMessenger();
    fake.chats = [
      activeChat('active'),
      activeChat('quiet', { lastActivity: at(-60) }),
      activeChat('archived', { isArchived: true }),
    ];
    fake.messages = [message('m1', 'active', 5), message('m2', 'archived', 5)];
    const activity = await collector(fake).collect(window);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['active']);
    expect(fake.listed).toEqual(['active']);
  });

  it("counts a message at the window's very end in it, and one at its very start as before it", async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1')];
    fake.messages = [message('at-start', 'c1', 0), message('at-end', 'c1', 24 * 60)];
    const [chat] = (await collector(fake).collect(window)).chats;
    expect(ids(chat!.messages)).toEqual(['at-end']);
    expect(ids(chat!.earlier)).toEqual(['at-start']);
  });

  it('passes over a message whose time it cannot read', async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1')];
    fake.messages = [message('in', 'c1', 5), makeMessage({ id: 'garbled', chatId: 'c1', timestamp: 'yesterday-ish' })];
    const [chat] = (await collector(fake).collect(window)).chats;
    expect(ids(chat!.messages)).toEqual(['in']);
    expect(chat!.earlier).toEqual([]);
  });

  it('leaves out a chat whose activity in the window left no message to show', async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1'), activeChat('c2')];
    fake.messages = [message('m1', 'c1', 5), message('old', 'c2', -30), message('gone', 'c2', 30, { isDeleted: true })];
    const activity = await collector(fake).collect(window);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['c1']);
  });

  it('keeps only what shows in the chat: no deleted, hidden or empty messages, but media and reactions count', async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1')];
    fake.messages = [
      message('deleted', 'c1', 1, { isDeleted: true }),
      message('hidden', 'c1', 2, { isHidden: true }),
      message('empty', 'c1', 3, { text: '  ' }),
      message('notice-empty', 'c1', 4, { text: '', kind: 'notice' }),
      message('photo', 'c1', 5, { text: '', attachments: [{ type: 'img' }] }),
      message('reaction', 'c1', 6, { text: '', kind: 'reaction' }),
      message('words', 'c1', 7),
    ];
    const activity = await collector(fake).collect(window);
    expect(ids(activity.chats[0]!.messages)).toEqual(['photo', 'reaction', 'words']);
  });

  it("leaves out messages from after the window's end, which arrived while it was read", async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('c1')];
    fake.messages = [message('in', 'c1', 10), message('later', 'c1', 24 * 60 + 1)];
    const activity = await collector(fake).collect(window);
    expect(ids(activity.chats[0]!.messages)).toEqual(['in']);
  });

  it.each([Infinity, 2])(
    'keeps the newest messages of a busy chat, says older ones in the window were left out, and keeps no context from before it (%s a page)',
    async (pageSize) => {
      const fake = new FakeMessenger();
      fake.pageSize = pageSize;
      fake.chats = [activeChat('c1')];
      fake.messages = [message('before', 'c1', -5), ...[1, 2, 3, 4, 5].map((n) => message(`in-${n}`, 'c1', n))];
      const activity = await collector(fake, { messagesPerChat: 2 }).collect(window);
      expect(ids(activity.chats[0]!.messages)).toEqual(['in-4', 'in-5']);
      expect(activity.chats[0]!.truncated).toBe(true);
      // What came before the window wouldn't come right before what was kept.
      expect(activity.chats[0]!.earlier).toEqual([]);
      expect(activity.partial).toBe(1);
    },
  );

  it('stops reading a busy chat as soon as it has more than it keeps', async () => {
    const fake = new CountingMessenger();
    fake.pageSize = 2;
    fake.chats = [activeChat('c1')];
    fake.messages = Array.from({ length: 10 }, (_, n) => message(`in-${n}`, 'c1', n + 1));
    await collector(fake, { messagesPerChat: 2 }).collect(window);
    expect(fake.listed).toEqual(['c1', 'c1']);
  });

  it('reads a chat only as far back as it needs, not its whole history', async () => {
    const fake = new CountingMessenger();
    fake.pageSize = 5;
    fake.chats = [activeChat('c1')];
    fake.messages = [
      ...[1, 2, 3].map((n) => message(`in-${n}`, 'c1', n)),
      ...Array.from({ length: 50 }, (_, n) => message(`old-${n}`, 'c1', -10 - n)),
    ];
    const activity = await collector(fake, { earlierMessages: 3 }).collect(window);
    expect(ids(activity.chats[0]!.messages)).toEqual(['in-1', 'in-2', 'in-3']);
    expect(ids(activity.chats[0]!.earlier)).toEqual(['old-2', 'old-1', 'old-0']);
    expect(fake.listed).toEqual(['c1', 'c1']); // 2 of its 11 pages
  });

  it('reads past messages that don\'t show to find the context it keeps', async () => {
    const fake = new FakeMessenger();
    fake.pageSize = 2;
    fake.chats = [activeChat('c1')];
    fake.messages = [
      message('in', 'c1', 5),
      message('gone-1', 'c1', -1, { isDeleted: true }),
      message('gone-2', 'c1', -2, { isHidden: true }),
      message('before', 'c1', -3),
    ];
    const activity = await collector(fake, { earlierMessages: 1 }).collect(window);
    expect(ids(activity.chats[0]!.earlier)).toEqual(['before']);
  });

  it('stops after its page limit for one chat, and says the window was cut', async () => {
    const fake = new CountingMessenger();
    fake.pageSize = 5;
    fake.chats = [activeChat('c1')];
    fake.messages = Array.from({ length: 30 }, (_, n) => message(`in-${n}`, 'c1', 600 - n));
    const activity = await collector(fake, { pagesPerChat: 2 }).collect(window);
    expect(fake.listed).toHaveLength(2);
    expect(activity.chats[0]!.messages).toHaveLength(10);
    expect(activity.chats[0]!.truncated).toBe(true);
    expect(activity.partial).toBe(1);
  });

  it('reaches the start of the window on its last page, so the window is whole, with what context that page held', async () => {
    const fake = new CountingMessenger();
    fake.pageSize = 2;
    fake.chats = [activeChat('c1')];
    fake.messages = [
      message('in-1', 'c1', 10),
      message('in-2', 'c1', 20),
      message('gone', 'c1', -1, { isHidden: true }),
      message('before', 'c1', -2),
      message('older', 'c1', -3),
    ];
    const activity = await collector(fake, { pagesPerChat: 2, earlierMessages: 3 }).collect(window);
    expect(fake.listed).toHaveLength(2);
    expect(ids(activity.chats[0]!.messages)).toEqual(['in-1', 'in-2']);
    expect(ids(activity.chats[0]!.earlier)).toEqual(['before']);
    expect(activity.chats[0]!.truncated).toBe(false);
    expect(activity.partial).toBe(0);
  });

  it("counts a chat it couldn't finish reading even when nothing it read shows", async () => {
    const fake = new FakeMessenger();
    fake.pageSize = 2;
    fake.chats = [activeChat('c1')];
    fake.messages = [
      message('are-you-coming', 'c1', 1),
      ...Array.from({ length: 6 }, (_, n) => message(`hidden-${n}`, 'c1', 10 + n, { isHidden: true })),
    ];
    const activity = await collector(fake, { pagesPerChat: 2 }).collect(window);
    expect(activity.chats).toEqual([]);
    expect(activity.partial).toBe(1);
  });

  it('asks for no more of the chat list than it needs', async () => {
    const many = new CountingMessenger();
    listInOrder(many, Array.from({ length: 100 }, (_, n) => `c${n}`));
    const capped = await collector(many, { chats: 40 }).collect(window);
    expect(capped.chats).toHaveLength(40);
    expect(capped.moreChats).toBe(true);
    // Two pages of twenty hold its forty chats; then the first page again, for one that moved to the top.
    expect(many.searches).toEqual([undefined, '20', undefined]);

    const few = new CountingMessenger();
    listInOrder(few, ['a', 'b', 'c']);
    await collector(few).collect(window);
    // One page holds them all, so none can have moved past a page already read.
    expect(few.searches).toEqual([undefined]);
  });

  it('reads no more chats than its chat limit, though a page of the list holds more', async () => {
    const fake = new CountingMessenger();
    listInOrder(fake, ['a', 'b', 'c', 'd', 'e']);
    const activity = await collector(fake, { chats: 3 }).collect(window);
    expect(fake.listed).toEqual(['a', 'b', 'c']);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b', 'c']);
    expect(activity.moreChats).toBe(true);
  });

  it('says there were more chats when the list has more but gives no way to ask for them', async () => {
    class NoCursor extends CountingMessenger {
      override async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
        this.searches.push(query?.cursor);
        return { items: this.chats, hasMore: true };
      }
    }
    const fake = new NoCursor();
    listInOrder(fake, ['a', 'b']);
    const activity = await collector(fake).collect(window);
    expect(fake.searches).toEqual([undefined]);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b']);
    expect(activity.moreChats).toBe(true);
  });

  it('pages through the chat search, and stops at its chat limit, saying there were more', async () => {
    const fake = new FakeMessenger();
    fake.chats = Array.from({ length: 30 }, (_, n) => activeChat(`c${n}`));
    fake.messages = fake.chats.map((c, n) => message(`m${n}`, c.id, n + 1));
    const all = await collector(fake, { chats: 40 }).collect(window);
    expect(all.chats).toHaveLength(30); // two pages of the search
    expect(all.moreChats).toBe(false);

    const capped = await collector(fake, { chats: 25 }).collect(window);
    expect(capped.chats).toHaveLength(25);
    expect(capped.moreChats).toBe(true);
  });

  it('reads a chat once when it comes up again on a later page, as one that gets a message while the list is read does', async () => {
    class Shifting extends CountingMessenger {
      override async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
        const [a, b, c] = this.chats;
        return query?.cursor === undefined
          ? { items: [a!, b!], hasMore: true, nextCursor: 'page-2' }
          : { items: [b!, c!], hasMore: false };
      }
    }
    const fake = new Shifting();
    fake.chats = [activeChat('a'), activeChat('b'), activeChat('c')];
    fake.messages = [message('m-a', 'a', 1), message('m-b', 'b', 2), message('m-c', 'c', 3)];
    const activity = await collector(fake).collect(window);
    expect(fake.listed.sort()).toEqual(['a', 'b', 'c']);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['c', 'b', 'a']);
  });

  it('stops looking through the chat search after its page limit, however many pages it says remain, and says there were more', async () => {
    class Endless extends FakeMessenger {
      cursors: (string | undefined)[] = [];
      override async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
        this.cursors.push(query?.cursor);
        // Every chat on the page is one the policy hides, so none counts toward the chat limit.
        return { items: [], hasMore: true, nextCursor: `page-${this.cursors.length + 1}` };
      }
    }
    const fake = new Endless();
    const activity = await collector(fake, { chatListPages: 3 }).collect(window);
    // Three pages, then the first again.
    expect(fake.cursors).toEqual([undefined, 'page-2', 'page-3', undefined]);
    expect(activity).toMatchObject({ chats: [], moreChats: true });
  });

  it('reads a chat that moved to the top of the list while the list was paged through, past the pages already read', async () => {
    const fake = new Jumping();
    fake.pageSize = 2;
    listInOrder(fake, ['a', 'b', 'c', 'd']);
    const activity = await collector(fake).collect(window);
    expect(fake.listed.sort()).toEqual(['a', 'b', 'c', 'd']);
    // Ranked by its message in the window, not the one after it that moved it.
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(activity.chats[3]!.messages)).toEqual(['m-d']);
    expect(activity.moreChats).toBe(false);
  });

  it('ranks a chat that moved to the top by what it had in the window, so its chat limit keeps the latest chats', async () => {
    const fake = new Jumping();
    fake.pageSize = 2;
    listInOrder(fake, ['a', 'b', 'c', 'd', 'e']);
    // e is busy too: more in the window than a chat's messages are kept.
    fake.messages.push(...[1, 2, 3].map((n) => message(`e-${n}`, 'e', n / 10)));
    const activity = await collector(fake, { chats: 3, messagesPerChat: 2 }).collect(window);
    // It is read, but what it had in the window is older than all the rest.
    expect([...new Set(fake.listed)].sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b', 'c']);
    expect(activity.moreChats).toBe(true);
    // Left out whole, it isn't one the digest read in part.
    expect(activity.partial).toBe(0);
  });

  it('says there were more chats when one that moved to the top takes it past its chat limit, though the list ended', async () => {
    const fake = new Jumping();
    fake.pageSize = 2;
    listInOrder(fake, ['a', 'b', 'c', 'd']);
    const activity = await collector(fake, { chats: 3 }).collect(window);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b', 'c']);
    expect(activity.moreChats).toBe(true);
  });

  it('reads a chat once when the first page, read again, holds it twice', async () => {
    class Repeating extends CountingMessenger {
      override async searchChats(query?: ChatQuery): Promise<Page<Chat>> {
        this.searches.push(query?.cursor);
        const [a, b, c, x] = this.chats;
        if (this.searches.length === 1) return { items: [a!, b!], hasMore: true, nextCursor: 'page-2' };
        if (this.searches.length === 2) return { items: [c!], hasMore: false };
        return { items: [x!, x!, a!], hasMore: true, nextCursor: 'page-2' };
      }
    }
    const fake = new Repeating();
    listInOrder(fake, ['a', 'b', 'c', 'x']);
    const activity = await collector(fake).collect(window);
    expect(fake.listed.sort()).toEqual(['a', 'b', 'c', 'x']);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['a', 'b', 'c', 'x']);
  });

  it('says nothing more is out there when exactly its chat limit was active', async () => {
    const fake = new FakeMessenger();
    fake.chats = Array.from({ length: 20 }, (_, n) => activeChat(`c${n}`));
    fake.messages = fake.chats.map((c, n) => message(`m${n}`, c.id, n + 1));
    const activity = await collector(fake, { chats: 20 }).collect(window);
    expect(activity.chats).toHaveLength(20);
    expect(activity.moreChats).toBe(false);
  });

  it('puts the chats with the latest messages first', async () => {
    const fake = new FakeMessenger();
    fake.chats = [activeChat('early'), activeChat('late'), activeChat('middle')];
    fake.messages = [message('e', 'early', 10), message('l', 'late', 300), message('m', 'middle', 100)];
    const activity = await collector(fake).collect(window);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['late', 'middle', 'early']);
  });

  it('goes on past a chat that fails on its own, and counts it', async () => {
    class Failing extends FakeMessenger {
      override listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
        if (chatId === 'broken') return Promise.reject(new ProviderError('Beeper API error (500): bridge down'));
        if (chatId === 'vanished') return Promise.reject(new NotFoundError('no such chat'));
        return super.listMessages(chatId, query);
      }
    }
    const fake = new Failing();
    fake.chats = [activeChat('fine'), activeChat('broken'), activeChat('vanished')];
    fake.messages = [message('m1', 'fine', 5)];
    const activity = await collector(fake).collect(window);
    expect(activity.chats.map((c) => c.chat.id)).toEqual(['fine']);
    expect(activity.unreadable).toBe(2);
  });

  it('fails as a whole when no chat could be read, rather than writing a digest of nothing', async () => {
    class Broken extends FakeMessenger {
      override listMessages(): Promise<Page<Message>> {
        return Promise.reject(new ProviderError('Beeper API error (500): everything is down'));
      }
    }
    const fake = new Broken();
    fake.chats = [activeChat('c1'), activeChat('c2')];
    await expect(collector(fake).collect(window)).rejects.toThrow('everything is down');
  });

  it.each([
    ['a lost connection', new ConnectionError('Cannot reach the Beeper Client API')],
    ['a rejected token', new AuthError('The Beeper Client API rejected the access token.')],
    ['an audit log that cannot be written', new Error('EACCES: permission denied, open audit.jsonl')],
  ])('stops the whole read on %s, even after chats that read fine', async (_, failure) => {
    class Failing extends FakeMessenger {
      override listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
        return chatId === 'c2' ? Promise.reject(failure) : super.listMessages(chatId, query);
      }
    }
    const fake = new Failing();
    fake.chats = [activeChat('c1'), activeChat('c2')];
    fake.messages = [message('m1', 'c1', 5)];
    await expect(collector(fake).collect(window)).rejects.toBe(failure);
  });
});
