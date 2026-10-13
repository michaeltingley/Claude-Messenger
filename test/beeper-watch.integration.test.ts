import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/core/types.js';
import { AuthError } from '../src/core/errors.js';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

/**
 * BeeperMessenger.watchMessages over real HTTP against the mock's model of
 * Beeper's message search: the requests a watch makes, and what it delivers
 * from what they return.
 */
describe('BeeperMessenger.watchMessages (HTTP integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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
  function follow(since: string, accessToken = mock.token) {
    const messenger = new BeeperMessenger({ accessToken, baseUrl, maxRetries: 0, pollIntervalMs: 50 });
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
    return { stop, got, state, finished, ids: () => got.map((m) => m.id) };
  }

  const searches = () => mock.requests.filter((r) => r.path === '/v1/messages/search');

  it('reads only your own messages, in every chat, muted and low-priority ones too', async () => {
    const since = ago(60 * 60_000);
    mock.messages = [
      wireMessage({ id: 'mine', isSender: true, senderID: 'me', timestamp: ago(30 * 60_000) }),
      wireMessage({ id: 'theirs', isSender: false, timestamp: ago(25 * 60_000) }),
      wireMessage({ id: 'in-muted', chatID: '!muted:beeper.com', isSender: true, senderID: 'me', timestamp: ago(20 * 60_000) }),
      wireMessage({ id: 'in-lowprio', chatID: '!lowprio:beeper.com', isSender: true, senderID: 'me', timestamp: ago(10 * 60_000) }),
    ];
    const watch = follow(since);
    await vi.waitFor(() => expect(watch.ids()).toEqual(['mine', 'in-muted', 'in-lowprio']));
    expect(watch.got[0]).toMatchObject({ isFromMe: true, chatId: '!chat1:beeper.com', text: 'hello from alice' });

    const first = searches()[0]!.query;
    expect(first.get('sender')).toBe('me');
    expect(first.get('dateAfter')).toBe(since);
    watch.stop.abort();
    await watch.finished;
  });

  it('catches up across pages, oldest first, within the page size Beeper serves', async () => {
    const since = ago(2 * 60 * 60_000);
    mock.messages = Array.from({ length: 45 }, (_, i) =>
      wireMessage({ id: `m${i}`, isSender: true, senderID: 'me', timestamp: ago((60 - i) * 60_000) }),
    );
    const watch = follow(since);
    await vi.waitFor(() => expect(watch.got).toHaveLength(45));
    expect(watch.ids()).toEqual(mock.messages.map((m) => m.id));
    // The mock refuses pages over 20, as Beeper's reference allows no more.
    expect(searches().slice(0, 3).map((r) => r.query.get('limit'))).toEqual(['20', '20', '20']);
    watch.stop.abort();
    await watch.finished;
    expect(watch.state.error).toBeUndefined();
  });

  it('delivers new messages as they arrive, including one that shows up late, dated before earlier polls', async () => {
    const watch = follow(ago(60_000));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(2));
    mock.messages.push(wireMessage({ id: 'live', isSender: true, senderID: 'me', timestamp: ago(0) }));
    await vi.waitFor(() => expect(watch.ids()).toEqual(['live']));

    const polls = searches().length;
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(polls + 2));
    // Sent three seconds ago, reaching Beeper only now (a bridge catching up).
    mock.messages.push(wireMessage({ id: 'late', isSender: true, senderID: 'me', timestamp: ago(3_000) }));
    await vi.waitFor(() => expect(watch.ids()).toEqual(['live', 'late']));
    watch.stop.abort();
    await watch.finished;
  });

  it('stops polling once aborted', async () => {
    const watch = follow(ago(0));
    await vi.waitFor(() => expect(searches().length).toBeGreaterThan(0));
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
    await vi.waitFor(() => expect(searches()).toHaveLength(1));
    watch.stop.abort();
    await watch.finished;
    expect(watch.state).toEqual({ done: true });
  });

  it("ends with Beeper's error translated, as when the token is rejected", async () => {
    const watch = follow(ago(0), 'wrong-token');
    await watch.finished;
    expect(watch.state.error).toBeInstanceOf(AuthError);
  });
});
