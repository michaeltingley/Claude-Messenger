import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/core/types.js';
import { AuthError, BacklogTooLargeError, ProviderError } from '../src/core/errors.js';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { MockBeeperServer, wireChat, wireMessage, type WireMessage } from './mock-beeper.js';

const MINUTE = 60_000;
/** Long enough for a slow CI runner; a regression fails with what the watch saw. */
const WAIT = { timeout: 10_000 };

/**
 * BeeperMessenger.watchMessages over real HTTP against the mock's model of
 * Beeper's message search, and of its push feed when that is on: the
 * requests a watch makes, and what it delivers from what they return and
 * what Beeper pushes. The client keeps its default retries, as the app's
 * does, so these also show that a watch never waits on one.
 */
describe('BeeperMessenger.watchMessages (HTTP integration)', { timeout: 30_000 }, () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const mine = (overrides: Partial<WireMessage>) => wireMessage({ isSender: true, senderID: 'me', ...overrides });

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.chats = [
      wireChat(),
      wireChat({ id: '!muted:beeper.com', title: 'Muted group', type: 'group', isMuted: true }),
      wireChat({ id: '!lowprio:beeper.com', title: 'Low priority', isLowPriority: true }),
    ];
  });

  afterEach(async () => {
    await mock.stop();
  });

  /** Watches in the background until stopped, recording what arrives and how it ends. */
  function follow(since: string, { accessToken = mock.token, pollIntervalMs = 50 } = {}) {
    const messenger = new BeeperMessenger({ accessToken, baseUrl, pollIntervalMs });
    const stop = new AbortController();
    const got: Message[] = [];
    const state: { error?: unknown; done: boolean } = { done: false };
    const finished = (async () => {
      try {
        for await (const m of messenger.watchMessages({ sender: 'me', since }, stop.signal)) got.push(m);
      } catch (err) {
        state.error = err;
      } finally {
        state.done = true;
      }
    })();
    const ids = () => got.map((m) => m.id);
    /** What the watch has seen so far, for a failing assertion to show. */
    const seen = () => `delivered ${JSON.stringify(ids())}, error ${String(state.error)}`;
    /** Waits for the watch to end on its own, or fails saying what it saw instead. */
    const ended = () => vi.waitFor(() => expect(state.done, seen()).toBe(true), WAIT);
    return { stop, got, state, finished, ids, seen, ended };
  }

  const searches = () => mock.requests.filter((r) => r.path === '/v1/messages/search');

  it('reads only your own messages, in every chat, muted and low-priority ones too', async () => {
    const since = ago(60 * MINUTE);
    mock.messages = [
      mine({ id: 'mine', timestamp: ago(30 * MINUTE) }),
      wireMessage({ id: 'theirs', isSender: false, timestamp: ago(25 * MINUTE) }),
      mine({ id: 'in-muted', chatID: '!muted:beeper.com', timestamp: ago(20 * MINUTE) }),
      mine({ id: 'in-lowprio', chatID: '!lowprio:beeper.com', timestamp: ago(10 * MINUTE) }),
    ];
    const watch = follow(since);
    await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['mine', 'in-muted', 'in-lowprio']), WAIT);
    expect(watch.got[0]).toMatchObject({ isFromMe: true, chatId: '!chat1:beeper.com', text: 'hello from alice' });

    const first = searches()[0]!.query;
    expect(first.get('sender')).toBe('me');
    expect(first.get('dateAfter')).toBe(since);
    watch.stop.abort();
    await watch.finished;
  });

  it('catches up on as many as 1,000 of your messages at once, oldest first across pages', async () => {
    // Older than the late window, so once caught up the watch stops asking for them.
    mock.messages = Array.from({ length: 1000 }, (_, i) => mine({ id: `m${i}`, timestamp: ago(2 * 60 * MINUTE - i * 5_000) }));
    const watch = follow(ago(3 * 60 * MINUTE));
    await vi.waitFor(() => expect(watch.got.length, watch.seen()).toBe(1000), WAIT);
    expect(watch.ids()).toEqual(mock.messages.map((m) => m.id));
    watch.stop.abort();
    await watch.finished;
    expect(watch.state.error).toBeUndefined();
  });

  it('fails, naming the way out, rather than skip any past 1,000', async () => {
    mock.messages = Array.from({ length: 1001 }, (_, i) => mine({ id: `m${i}`, timestamp: ago(2 * 60 * MINUTE - i * 5_000) }));
    const since = ago(3 * 60 * MINUTE);
    const watch = follow(since);
    await watch.ended();
    expect(watch.ids()).toEqual([]);
    expect(watch.state.error).toBeInstanceOf(BacklogTooLargeError);
    expect((watch.state.error as Error).message).toBe(
      `More than 1000 messages to catch up on after ${since}. Watch from a later time.`,
    );
  });

  it('delivers new messages as they arrive, including one that shows up late, dated before earlier polls', async () => {
    const watch = follow(ago(MINUTE));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(2), WAIT);
    mock.messages.push(mine({ id: 'live', timestamp: ago(0) }));
    await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['live']), WAIT);

    const polls = searches().length;
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(polls + 2), WAIT);
    // Sent three seconds ago, reaching Beeper only now (a bridge catching up).
    mock.messages.push(mine({ id: 'late', timestamp: ago(3_000) }));
    await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['live', 'late']), WAIT);
    watch.stop.abort();
    await watch.finished;
  });

  it('delivers a message that reaches Beeper up to ten minutes late, and misses one later than that', async () => {
    const watch = follow(ago(60 * MINUTE));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(2), WAIT); // caught up: only the window is asked for now
    mock.messages.push(mine({ id: 'eleven-late', timestamp: ago(11 * MINUTE) }), mine({ id: 'nine-late', timestamp: ago(9 * MINUTE) }));
    await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['nine-late']), WAIT);
    const polls = searches().length;
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(polls + 2), WAIT);
    expect(watch.ids()).toEqual(['nine-late']);
    watch.stop.abort();
    await watch.finished;
  });

  it('fails at once with Beeper’s error rather than retry behind the watch, which a stop could not cut short', async () => {
    mock.forcedError = { status: 503 };
    const watch = follow(ago(0));
    await watch.ended();
    expect(watch.state.error).toBeInstanceOf(ProviderError);
    expect(searches()).toHaveLength(1);
  });

  it('leaves nothing listening on the caller’s signal, however many polls it makes', async () => {
    const watch = follow(ago(0));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(30), WAIT);
    // The watch's own, and nothing per poll: the HTTP client's listener on each request goes with it.
    expect(getEventListeners(watch.stop.signal, 'abort').length).toBeLessThanOrEqual(1);
    watch.stop.abort();
    await watch.finished;
  });

  it('stops polling once aborted', async () => {
    const watch = follow(ago(0));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(0), WAIT);
    watch.stop.abort();
    await watch.finished;
    expect(watch.state).toEqual({ done: true });
    const polls = searches().length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(searches()).toHaveLength(polls);
  });

  it('stops at once when aborted while Beeper is not answering', async () => {
    mock.stalls = (path) => path === '/v1/messages/search';
    const watch = follow(ago(0));
    await vi.waitFor(() => expect(searches()).toHaveLength(1), WAIT);
    watch.stop.abort();
    await watch.finished;
    expect(watch.state).toEqual({ done: true });
  });

  it("ends with Beeper's error translated, as when the token is rejected", async () => {
    const watch = follow(ago(0), { accessToken: 'wrong-token' });
    await watch.ended();
    expect(watch.state.error).toBeInstanceOf(AuthError);
  });

  describe("with Beeper's push feed on", () => {
    beforeEach(() => {
      mock.pushFeed = true;
    });

    const subscribed = (count: number) => vi.waitFor(() => expect(mock.subscriptions).toHaveLength(count), WAIT);

    it('delivers what Beeper pushes at once, without waiting for the next search', async () => {
      const watch = follow(ago(MINUTE), { pollIntervalMs: 60 * MINUTE });
      await subscribed(1);
      await vi.waitFor(() => expect(searches()).toHaveLength(1), WAIT);
      mock.upsert(mine({ id: 'pushed', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['pushed']), WAIT);
      expect(searches()).toHaveLength(1);
      // The feed listens on the watch's own signal, not the caller's.
      expect(getEventListeners(watch.stop.signal, 'abort').length).toBeLessThanOrEqual(1);
      watch.stop.abort();
      await watch.finished;
      expect(watch.state).toEqual({ done: true });
    });

    it('delivers by search what Beeper never pushes, and once what both push and search find', async () => {
      const watch = follow(ago(MINUTE), { pollIntervalMs: 200 });
      await subscribed(1);
      mock.upsert(mine({ id: 'pushed', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['pushed']), WAIT);
      // Put straight in, as a message Beeper couldn't read yet when it came, which it never pushes.
      mock.messages.push(mine({ id: 'unpushed', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['pushed', 'unpushed']), WAIT);
      // Every search since has found both.
      const polls = searches().length;
      await vi.waitFor(() => expect(searches().length).toBeGreaterThan(polls + 2), WAIT);
      expect(watch.ids()).toEqual(['pushed', 'unpushed']);
      watch.stop.abort();
      await watch.finished;
    });

    it('delivers a message once, however often Beeper pushes it, as it does an edit', async () => {
      const watch = follow(ago(MINUTE), { pollIntervalMs: 60 * MINUTE });
      await subscribed(1);
      const sent = mine({ id: 'edited', timestamp: ago(0), text: 'dinner at 8' });
      mock.upsert(sent);
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['edited']), WAIT);
      mock.upsert({ ...sent, text: 'dinner at 9' });
      mock.upsert(mine({ id: 'next', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['edited', 'next']), WAIT);
      expect(watch.got[0]!.text).toBe('dinner at 8');
      watch.stop.abort();
      await watch.finished;
    });

    it('goes on searching while the feed is down, and takes pushes again once it is back', async () => {
      const watch = follow(ago(MINUTE), { pollIntervalMs: 200 });
      await subscribed(1);
      mock.dropFeeds();
      mock.messages.push(mine({ id: 'while-down', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['while-down']), WAIT);
      await subscribed(2);
      mock.upsert(mine({ id: 'after', timestamp: ago(0) }));
      await vi.waitFor(() => expect(watch.ids(), watch.seen()).toEqual(['while-down', 'after']), WAIT);
      expect(watch.state.error).toBeUndefined();
      watch.stop.abort();
      await watch.finished;
    });

    it('closes its feed when it ends, stopped or failed', async () => {
      const stopped = follow(ago(0));
      await subscribed(1);
      stopped.stop.abort();
      await stopped.finished;
      await vi.waitFor(() => expect(mock.feedsOpen).toBe(0), WAIT);

      const failed = follow(ago(0));
      await subscribed(2);
      mock.forcedError = { status: 503 };
      await failed.ended();
      expect(failed.state.error).toBeInstanceOf(ProviderError);
      await vi.waitFor(() => expect(mock.feedsOpen).toBe(0), WAIT);
    });
  });
});
