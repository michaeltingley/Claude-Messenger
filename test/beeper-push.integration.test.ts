import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { openPushFeed, type PushFeedOptions } from '../src/providers/beeper/push.js';
import type { PushFeed } from '../src/providers/push-feed.js';
import { MockBeeperServer, wireChat, wireMessage, type WireMessage } from './mock-beeper.js';
import { unusedPort } from './ports.js';

/** Long enough for a slow CI runner; a regression fails with what the feed got. */
const WAIT = { timeout: 10_000, interval: 5 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

/**
 * openPushFeed over a real WebSocket against the mock's model of Beeper's
 * push feed: how it connects and subscribes, which of the messages Beeper
 * pushes it hands a watch, and how it carries on when Beeper ends a
 * connection, refuses one, or sends what it can't read.
 */
describe('openPushFeed (WebSocket integration)', { timeout: 30_000 }, () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let stop: AbortController;
  const mine = (overrides: Partial<WireMessage>) => wireMessage({ isSender: true, senderID: 'me', ...overrides });

  beforeEach(async () => {
    mock = new MockBeeperServer();
    mock.pushFeed = true;
    baseUrl = await mock.start();
    mock.chats = [wireChat()];
    stop = new AbortController();
  });

  afterEach(async () => {
    stop.abort();
    await mock.stop();
  });

  const open = (options: Partial<PushFeedOptions> = {}) =>
    openPushFeed(
      { baseUrl, accessToken: mock.token, sender: 'me', retry: { firstMs: 10, maxMs: 1_000 }, ...options },
      stop.signal,
    );
  /** Every time the feed asked to connect, accepted or not. */
  const attempts = () => mock.requests.filter((r) => r.path === '/v1/ws');
  const subscribed = (count: number) => vi.waitFor(() => expect(mock.subscriptions).toHaveLength(count), WAIT);
  /** The IDs of what the feed holds as soon as it holds any, or none after five seconds. */
  const nextIds = async (feed: PushFeed) => (await feed.next(AbortSignal.timeout(5_000))).map((m) => m.id);

  it('subscribes to every chat once Beeper is ready, sending the token as a header and never in the address', async () => {
    open();
    await subscribed(1);
    expect(mock.subscriptions[0]).toEqual({ type: 'subscriptions.set', requestID: 'watch', chatIDs: ['*'] });
    // The mock accepts only a request whose Authorization header holds the token.
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]!.query.toString()).toBe('');
  });

  it('hands on your messages as Beeper pushes them, each read as Beeper’s message endpoint reads it', async () => {
    const feed = open();
    await subscribed(1);
    const sent = mine({
      id: 'photo',
      type: 'IMAGE',
      timestamp: now(),
      text: 'see <b>you</b> at 8',
      attachments: [{ type: 'img', fileName: 'dinner.jpg', mimeType: 'image/jpeg', fileSize: 2048, isSticker: false }],
      reactions: [{ id: 'r1', participantID: 'alice', reactionKey: '👍' }],
      isUnread: false,
      linkedMessageID: 'earlier',
    });
    mock.upsert(sent);
    const pushed = await feed.next(AbortSignal.timeout(5_000));
    const read = await new BeeperMessenger({ accessToken: mock.token, baseUrl }).getMessage(sent.chatID, sent.id);
    expect(pushed).toEqual([read]);
    expect(read).toMatchObject({ kind: 'image', text: 'see you at 8', replyToMessageId: 'earlier', isFromMe: true });
  });

  it("lets everyone else's messages go, and anything it can't read, and reads on", async () => {
    const feed = open();
    await subscribed(1);
    mock.upsert(wireMessage({ id: 'theirs', timestamp: now() }));
    mock.pushFrame('not JSON');
    mock.pushFrame(JSON.stringify(['not', 'an', 'event']));
    mock.pushFrame(JSON.stringify({ type: 'chat.upserted', seq: 90, chatID: '!chat1:beeper.com', ids: ['!chat1:beeper.com'] }));
    const upserted = { type: 'message.upserted', seq: 91, ts: Date.now(), chatID: '!chat1:beeper.com', ids: ['x'] };
    mock.pushFrame(JSON.stringify({ ...upserted, entries: 'not a list' }));
    mock.pushFrame(
      JSON.stringify({
        ...upserted,
        entries: [null, 7, ['a list'], { ...mine({ id: 'timeless' }), timestamp: 1_791_951_276_864 }, { isSender: true }],
      }),
    );
    mock.upsert(mine({ id: 'after', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['after']);
    // On the connection it had all along.
    expect(attempts()).toHaveLength(1);
  });

  it('pushes nothing for a change Beeper sends without its message: the scans deliver that one', async () => {
    const feed = open();
    await subscribed(1);
    mock.pushEntries = false;
    mock.upsert(mine({ id: 'bare', timestamp: now() }));
    mock.pushEntries = true;
    mock.upsert(mine({ id: 'whole', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['whole']);
  });

  it.each(['cut', 'close'] as const)('connects and subscribes again when Beeper ends the connection (%s)', async (how) => {
    const feed = open();
    await subscribed(1);
    mock.dropFeeds(how);
    await subscribed(2);
    mock.upsert(mine({ id: 'later', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['later']);
    expect(mock.feedsOpen).toBe(1);
  });

  it('starts over on a new connection when Beeper answers with an error', async () => {
    const feed = open();
    await subscribed(1);
    mock.pushFrame(JSON.stringify({ type: 'error', requestID: 'watch', code: 'INTERNAL', message: 'try again' }));
    await subscribed(2);
    expect(attempts()).toHaveLength(2);
    mock.upsert(mine({ id: 'later', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['later']);
  });

  it('asks again less often each time Beeper refuses it, up to the longest wait', async () => {
    mock.pushFeed = false; // as a Beeper without the feed, which answers 404
    open({ retry: { firstMs: 20, maxMs: 80 } });
    await vi.waitFor(() => expect(attempts().length).toBeGreaterThanOrEqual(12), WAIT);
    const at = attempts().map((r) => r.at);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // 20, 40, 80, then 80 on: each at least that, less a millisecond for the clock's rounding.
    gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(Math.min(20 * 2 ** i, 80) - 1));
    // And the typical one once it stops growing, so one stall on a busy machine can't fail it.
    const capped = gaps.slice(3).sort((a, b) => a - b);
    expect(capped[Math.floor(capped.length / 2)]).toBeLessThan(160);
    expect(mock.subscriptions).toHaveLength(0);
  });

  it('waits the least again after a connection that held as long as the longest wait, and only after one', async () => {
    mock.pushFeed = false;
    open({ retry: { firstMs: 20, maxMs: 640 } });
    // Refused four times, so the waits have grown to 160 at least.
    await vi.waitFor(() => expect(attempts().length).toBeGreaterThanOrEqual(4), WAIT);
    mock.pushFeed = true;
    await subscribed(1);

    // Dropped at once: the wait went on growing, to 320 at least.
    let dropped = Date.now();
    mock.dropFeeds();
    await subscribed(2);
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(300);

    // Held for the longest wait: the waits start over.
    await sleep(700);
    dropped = Date.now();
    mock.dropFeeds();
    await subscribed(3);
    expect(Date.now() - dropped).toBeLessThan(300);
  });

  it('finds the feed beside an API served under a path', async () => {
    mock.pathPrefix = '/beeper';
    const feed = open({ baseUrl: `${baseUrl}/beeper/` });
    await subscribed(1);
    mock.upsert(mine({ id: 'proxied', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['proxied']);
  });

  it('closes its connection when its signal aborts, and never connects again', async () => {
    open();
    await subscribed(1);
    stop.abort();
    await vi.waitFor(() => expect(mock.feedsOpen).toBe(0), WAIT);
    await sleep(100); // ten times its first wait
    expect(attempts()).toHaveLength(1);
  });

  it('stops for good when its signal aborts while it waits to connect again', async () => {
    mock.pushFeed = false;
    open({ retry: { firstMs: 200, maxMs: 1_000 } });
    // Refused twice, so it waits 400 before the third try.
    await vi.waitFor(() => expect(attempts()).toHaveLength(2), WAIT);
    stop.abort();
    await sleep(800);
    expect(attempts()).toHaveLength(2);
  });

  it('keeps asking while nothing answers where Beeper should be, and subscribes once it starts', async () => {
    const port = await unusedPort();
    const feed = open({ baseUrl: `http://127.0.0.1:${port}` });
    // Nothing listens there yet, so each try is refused before a request is made.
    await sleep(100);
    await mock.stop();
    mock = new MockBeeperServer();
    mock.pushFeed = true;
    await mock.start(port);
    await subscribed(1);
    mock.upsert(mine({ id: 'started', timestamp: now() }));
    expect(await nextIds(feed)).toEqual(['started']);
  });
});
