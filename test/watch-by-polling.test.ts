import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Page } from '../src/core/types.js';
import { BacklogTooLargeError, ProviderError } from '../src/core/errors.js';
import { PushedMessages } from '../src/providers/push-feed.js';
import { watchByPolling, type WatchByPollingOptions } from '../src/providers/watch-by-polling.js';
import { makeMessage } from './fake-messenger.js';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A searchable backend on the fake clock. Each message becomes visible at
 * `arrivesAt`, which may be later than its own timestamp, as when a bridge
 * reconnects. Search answers like Beeper's: matches strictly after
 * `dateAfter`, newest page first, `pageSize` per page.
 */
class Backend {
  private stored: Array<{ message: Message; arrivesAt: number }> = [];
  readonly requests: Array<{ dateAfter: string; cursor?: string }> = [];
  pageSize = 50;
  /** A backend that ignores `dateAfter` and always returns everything it has. */
  ignoresDateAfter = false;
  /** Replaces the answer to the next search, e.g. with a failure. */
  nextAnswer: ((signal: AbortSignal) => Promise<Page<Message>>) | undefined;

  /** A message with this ID and time, visible from `arrivesAt` (default: now). */
  add(id: string, timestamp: number | string, arrivesAt = Date.now()): void {
    const ts = typeof timestamp === 'number' ? iso(timestamp) : timestamp;
    this.stored.push({ message: makeMessage({ id, timestamp: ts, isFromMe: true }), arrivesAt });
  }

  fetchPage: WatchByPollingOptions['fetchPage'] = async ({ dateAfter, cursor, signal }) => {
    this.requests.push({ dateAfter, ...(cursor !== undefined && { cursor }) });
    const answer = this.nextAnswer;
    this.nextAnswer = undefined;
    if (answer) return answer(signal);
    const after = Date.parse(dateAfter);
    const visible = this.stored
      .filter((s) => s.arrivesAt <= Date.now() && (this.ignoresDateAfter || Date.parse(s.message.timestamp) > after))
      .map((s) => s.message)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const offset = cursor === undefined ? 0 : Number(cursor);
    const items = visible.slice(offset, offset + this.pageSize);
    const next = offset + items.length;
    return { items, hasMore: next < visible.length, nextCursor: String(next) };
  };
}

/** Runs the watch in the background, recording what it delivers and how it ends. */
function follow(options: Partial<WatchByPollingOptions> & Pick<WatchByPollingOptions, 'fetchPage'>) {
  const stop = new AbortController();
  const got: Message[] = [];
  const state: { done: boolean; error?: unknown } = { done: false };
  const finished = (async () => {
    try {
      for await (const m of watchByPolling({ since: iso(T0 - 30 * MINUTE), intervalMs: SECOND, ...options }, stop.signal)) {
        got.push(m);
      }
    } catch (err) {
      state.error = err;
    } finally {
      state.done = true;
    }
  })();
  return { stop, state, finished, got: () => got, ids: () => got.map((m) => m.id) };
}

/** Lets scans that are due run, and everything they await settle. */
const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('watchByPolling', () => {
  let backend: Backend;

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    backend = new Backend();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches up on matches after `since`, oldest first and across pages, then follows new arrivals', async () => {
    const since = T0 - 30 * MINUTE;
    backend.pageSize = 2;
    backend.add('before-since', since - MINUTE);
    backend.add('at-since', since); // `since` is exclusive
    backend.add('c', T0 - 5 * MINUTE);
    backend.add('a', T0 - 20 * MINUTE);
    backend.add('d', T0 - MINUTE);
    backend.add('b', T0 - 10 * MINUTE);

    const watch = follow({ since: iso(since), fetchPage: backend.fetchPage });
    await elapse(0);
    expect(watch.ids()).toEqual(['a', 'b', 'c', 'd']);

    backend.add('live', T0 + 500, T0 + 500);
    await elapse(SECOND);
    expect(watch.ids()).toEqual(['a', 'b', 'c', 'd', 'live']);

    watch.stop.abort();
    await watch.finished;
    expect(watch.state).toEqual({ done: true });
  });

  it('delivers each message once, though every scan inside the late window finds it again', async () => {
    backend.add('m', T0 - SECOND);
    const watch = follow({ fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    await elapse(10 * SECOND);
    expect(backend.requests.length).toBeGreaterThan(5);
    expect(watch.ids()).toEqual(['m']);
    watch.stop.abort();
  });

  it('delivers a message that reaches the backend late, timestamped before scans already done', async () => {
    const watch = follow({ fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    await elapse(30 * SECOND); // thirty scans find nothing
    backend.add('late', T0 + 2 * SECOND); // sent 28 s ago, only visible now
    await elapse(SECOND);
    expect(watch.ids()).toEqual(['late']);
    watch.stop.abort();
  });

  it('once caught up, asks only for the late window, not everything since `since`, so a message later than that is missed', async () => {
    const since = T0 - 24 * 60 * MINUTE;
    const watch = follow({ since: iso(since), fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    await elapse(0);
    expect(backend.requests[0]!.dateAfter).toBe(iso(since));

    await elapse(5 * MINUTE);
    const last = backend.requests.at(-1)!;
    // The scan before this one started a second earlier; the floor trails it by the window.
    expect(Date.parse(last.dateAfter)).toBe(Date.now() - SECOND - MINUTE);

    backend.add('too-late', Date.now() - 2 * MINUTE); // two windows late
    await elapse(3 * SECOND);
    expect(watch.ids()).toEqual([]);
    watch.stop.abort();
  });

  it('never reaches back before `since`, though the late window would', async () => {
    const watch = follow({ since: iso(T0), fetchPage: backend.fetchPage }); // the default ten-minute window
    await elapse(MINUTE);
    backend.add('sent-before-since', T0 - SECOND); // reaching the backend late
    await elapse(5 * SECOND);
    expect(watch.ids()).toEqual([]);
    watch.stop.abort();
  });

  it('repeats nothing, and still delivers what comes next, when the host clock steps back', async () => {
    backend.add('m', T0 - SECOND, 0); // on the backend whatever this host's clock says
    const watch = follow({ fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    await elapse(2 * MINUTE); // m is delivered, then falls behind the window and is forgotten
    expect(watch.ids()).toEqual(['m']);

    vi.setSystemTime(Date.now() - 30 * MINUTE); // an NTP correction
    await elapse(10 * SECOND);
    // Sent now by the network's clock, which is the one that was right.
    backend.add('next', Date.now() + 30 * MINUTE);
    await elapse(2 * SECOND);
    expect(watch.ids()).toEqual(['m', 'next']);
    watch.stop.abort();
  });

  it('delivers each message once by chat and ID: listed twice in one scan is once, the same ID in two chats is two', async () => {
    const at = iso(T0 - SECOND);
    const m = makeMessage({ id: 'm', chatId: 'chat-1', timestamp: at, isFromMe: true });
    const sameIdElsewhere = makeMessage({ id: 'm', chatId: 'chat-2', timestamp: at, isFromMe: true });
    backend.nextAnswer = async () => ({ items: [m, { ...m }, sameIdElsewhere], hasMore: false });
    const watch = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    expect(watch.ids()).toEqual(['m', 'm']);
    expect(new Set(watch.got().map((d) => d.chatId))).toEqual(new Set(['chat-1', 'chat-2']));
    watch.stop.abort();
  });

  it('never delivers a message again once its window has passed, even when the backend keeps returning it', async () => {
    backend.ignoresDateAfter = true;
    backend.add('m', T0 - SECOND);
    const watch = follow({ fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    await elapse(5 * MINUTE);
    expect(watch.ids()).toEqual(['m']);
    watch.stop.abort();
  });

  it('keeps delivering after a message dated in the future, rather than waiting for the clock to pass it', async () => {
    const watch = follow({ fetchPage: backend.fetchPage, lateWindowMs: MINUTE });
    backend.add('future', T0 + 60 * MINUTE); // a sender with a clock an hour fast
    await elapse(SECOND);
    backend.add('next', Date.now());
    await elapse(SECOND);
    expect(watch.ids()).toEqual(['future', 'next']);
    watch.stop.abort();
  });

  it('keeps going past a message whose time cannot be read, without delivering it', async () => {
    backend.add('garbled', 'not a time');
    backend.add('fine', T0 - SECOND);
    const watch = follow({ fetchPage: backend.fetchPage });
    await elapse(2 * SECOND);
    expect(watch.ids()).toEqual(['fine']);
    expect(watch.state.error).toBeUndefined();
    watch.stop.abort();
  });

  it('ends cleanly at once when aborted between scans, without waiting out the interval', async () => {
    const watch = follow({ fetchPage: backend.fetchPage, intervalMs: 60 * MINUTE });
    await elapse(0);
    watch.stop.abort();
    await watch.finished; // no timers advanced: the abort alone ends it
    expect(watch.state).toEqual({ done: true });
    expect(backend.requests).toHaveLength(1);
  });

  it('hands on nothing more once aborted, not even the rest of a scan already read', async () => {
    backend.add('a', T0 - 3 * SECOND);
    backend.add('b', T0 - 2 * SECOND);
    backend.add('c', T0 - SECOND);
    const stop = new AbortController();
    const got: string[] = [];
    for await (const m of watchByPolling({ since: iso(T0 - MINUTE), intervalMs: SECOND, fetchPage: backend.fetchPage }, stop.signal)) {
      got.push(m.id);
      stop.abort();
    }
    expect(got).toEqual(['a']);
  });

  it('gives each request its own signal, aborted with the watch, so a client that never lets go leaves nothing on the watch', async () => {
    const watch = follow({
      fetchPage: (request) => {
        // As the Beeper SDK does: a listener on the signal it is given, never removed.
        request.signal.addEventListener('abort', () => undefined);
        return backend.fetchPage(request);
      },
    });
    await elapse(100 * SECOND);
    expect(backend.requests.length).toBeGreaterThan(50);
    // The watch's own listener, and nothing per scan or wait.
    expect(getEventListeners(watch.stop.signal, 'abort').length).toBeLessThanOrEqual(1);
    watch.stop.abort();
  });

  it('ends cleanly when aborted while the backend has not answered', async () => {
    // Like an HTTP client: the request fails once its signal aborts.
    backend.nextAnswer = (signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Request was aborted.'))));
    const watch = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    expect(watch.state.done).toBe(false);
    watch.stop.abort();
    await watch.finished;
    expect(watch.state).toEqual({ done: true });
  });

  it('ends with the backend error, without retrying it', async () => {
    backend.add('m', T0 - SECOND);
    const watch = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    const failure = new ProviderError('Beeper API error (500): boom');
    backend.nextAnswer = () => Promise.reject(failure);
    await elapse(10 * SECOND);
    expect(watch.ids()).toEqual(['m']);
    expect(watch.state).toEqual({ done: true, error: failure });
    expect(backend.requests).toHaveLength(2);
  });

  it('fails, delivering nothing from that scan, rather than skip messages past its page cap', async () => {
    backend.pageSize = 2;
    for (let i = 1; i <= 5; i++) backend.add(`m${i}`, T0 - i * MINUTE);
    const watch = follow({ fetchPage: backend.fetchPage, maxPagesPerScan: 2 });
    await elapse(0);
    expect(watch.ids()).toEqual([]);
    expect(watch.state.error).toBeInstanceOf(BacklogTooLargeError);
    expect(String(watch.state.error)).toMatch(/More than 4 messages to catch up on after .*\. Watch from a later time\./);
  });

  it('takes as many as fifty pages in one scan unless told otherwise', async () => {
    backend.pageSize = 1;
    for (let i = 1; i <= 50; i++) backend.add(`m${i}`, T0 - i * SECOND);
    const fits = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    expect(fits.ids()).toHaveLength(50);
    fits.stop.abort();

    backend.add('m51', T0 - 51 * SECOND);
    const over = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    expect(over.state.error).toBeInstanceOf(BacklogTooLargeError);
  });

  it('fails, rather than skip messages, when the backend reports more but gives no way to fetch them', async () => {
    backend.nextAnswer = async () => ({ items: [makeMessage({ timestamp: iso(T0 - SECOND) })], hasMore: true });
    const watch = follow({ fetchPage: backend.fetchPage });
    await elapse(0);
    expect(watch.ids()).toEqual([]);
    expect(String(watch.state.error)).toMatch(/gave no cursor/);
  });

  it('refuses a `since` that is not a time', async () => {
    const watch = follow({ since: 'yesterday-ish', fetchPage: backend.fetchPage });
    await elapse(0);
    expect(watch.state.error).toBeInstanceOf(RangeError);
    expect(backend.requests).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'refuses an interval of %s ms, which would have it ask the backend without pause',
    async (intervalMs) => {
      const watch = follow({ intervalMs, fetchPage: backend.fetchPage });
      await elapse(0);
      expect(watch.state.error).toBeInstanceOf(RangeError);
      expect(backend.requests).toHaveLength(0);
    },
  );
});

describe('watchByPolling, with a push feed', () => {
  let backend: Backend;
  let pushed: PushedMessages;
  /** The signal each feed was opened with, in order: aborted when its watch ends. */
  let opened: AbortSignal[];
  const push = (signal: AbortSignal) => {
    opened.push(signal);
    return pushed;
  };
  const mine = (id: string, at: number) => makeMessage({ id, timestamp: iso(at), isFromMe: true });

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    backend = new Backend();
    pushed = new PushedMessages();
    opened = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers what the backend pushes between scans at once, oldest first within what comes together', async () => {
    const watch = follow({ fetchPage: backend.fetchPage, intervalMs: MINUTE, push });
    await elapse(0);
    expect(backend.requests).toHaveLength(1);
    pushed.push(mine('b', T0 + 2 * SECOND));
    pushed.push(mine('a', T0 + SECOND));
    await elapse(0);
    expect(watch.ids()).toEqual(['a', 'b']);
    // Delivered without a scan.
    expect(backend.requests).toHaveLength(1);
    watch.stop.abort();
  });

  it('delivers a message once, though it is pushed and found by a scan too, whichever comes first', async () => {
    const watch = follow({ fetchPage: backend.fetchPage, push });
    await elapse(0);
    pushed.push(mine('pushed-first', T0 + 100));
    backend.add('pushed-first', T0 + 100);
    await elapse(0);
    backend.add('found-first', T0 + 200);
    await elapse(SECOND);
    pushed.push(mine('found-first', T0 + 200)); // pushed late, as an edit is
    await elapse(5 * SECOND);
    expect(watch.ids()).toEqual(['pushed-first', 'found-first']);
    watch.stop.abort();
  });

  it('delivers nothing pushed that a scan would not: dated at or before `since`, or older than the window', async () => {
    const watch = follow({ since: iso(T0), fetchPage: backend.fetchPage, lateWindowMs: MINUTE, push });
    await elapse(0);
    pushed.push(mine('at-since', T0));
    pushed.push(mine('before-since', T0 - SECOND));
    await elapse(5 * MINUTE);
    // A change to an old message is pushed as Beeper pushes any.
    pushed.push(mine('older-than-the-window', Date.now() - 2 * MINUTE));
    pushed.push(mine('new', Date.now()));
    await elapse(0);
    expect(watch.ids()).toEqual(['new']);
    watch.stop.abort();
  });

  it('catches up first: what the first scan finds comes before anything pushed while it ran', async () => {
    let answer: ((page: Page<Message>) => void) | undefined;
    backend.nextAnswer = () => new Promise((resolve) => (answer = resolve));
    const watch = follow({ fetchPage: backend.fetchPage, push });
    await elapse(0);
    pushed.push(mine('pushed', T0 + SECOND));
    await elapse(0);
    expect(watch.ids()).toEqual([]);
    answer!({ items: [mine('caught-up', T0 - MINUTE)], hasMore: false });
    await elapse(0);
    expect(watch.ids()).toEqual(['caught-up', 'pushed']);
    watch.stop.abort();
  });

  it('scans on time, however much is pushed in between, even for a consumer that falls behind', async () => {
    const stop = new AbortController();
    let pushes = 0;
    const pusher = setInterval(() => pushed.push(mine(`p${pushes++}`, Date.now())), 100);
    const finished = (async () => {
      const options = { since: iso(T0 - MINUTE), intervalMs: SECOND, fetchPage: backend.fetchPage, push };
      for await (const _ of watchByPolling(options, stop.signal)) {
        await new Promise((resolve) => setTimeout(resolve, 150)); // slower than the pushes come
      }
    })();
    await elapse(10 * SECOND);
    clearInterval(pusher);
    // About one a second, never put off by the pushes still waiting.
    expect(backend.requests.length).toBeGreaterThanOrEqual(5);
    // The watch's own listener, and nothing per push.
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(1);
    stop.abort();
    await elapse(SECOND);
    await finished;
  });

  it('opens the feed as it starts, and closes it as it ends, however it ends', async () => {
    const stopped = follow({ fetchPage: backend.fetchPage, push });
    await elapse(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.aborted).toBe(false);
    stopped.stop.abort();
    await stopped.finished;
    expect(opened[0]!.aborted).toBe(true);

    const failed = follow({ fetchPage: backend.fetchPage, push });
    await elapse(0);
    backend.nextAnswer = () => Promise.reject(new ProviderError('Beeper API error (500): boom'));
    await elapse(SECOND);
    expect(failed.state.error).toBeInstanceOf(ProviderError);
    expect(opened[1]!.aborted).toBe(true);

    backend.add('m', T0 - SECOND);
    const options = { since: iso(T0 - MINUTE), intervalMs: SECOND, fetchPage: backend.fetchPage, push };
    for await (const _ of watchByPolling(options, new AbortController().signal)) {
      break; // a consumer that has what it wanted
    }
    expect(opened[2]!.aborted).toBe(true);
  });
});

describe('PushedMessages', () => {
  const pending = () => new AbortController().signal;

  it('hands over everything pushed since it was last asked, at once', async () => {
    const feed = new PushedMessages();
    feed.push(makeMessage({ id: 'a' }));
    feed.push(makeMessage({ id: 'b' }));
    expect((await feed.next(pending())).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('waits for the next push, or for the wait to be called off, whichever comes first', async () => {
    const feed = new PushedMessages();
    const waiting = feed.next(pending());
    feed.push(makeMessage({ id: 'a' }));
    expect((await waiting).map((m) => m.id)).toEqual(['a']);

    const until = new AbortController();
    const calledOff = feed.next(until.signal);
    until.abort();
    expect(await calledOff).toEqual([]);
    expect(getEventListeners(until.signal, 'abort')).toHaveLength(0);
  });

  it('holds at most 1,000 messages, letting further pushes go until they are taken', async () => {
    const feed = new PushedMessages();
    for (let i = 0; i < 1_001; i++) feed.push(makeMessage({ id: `m${i}` }));
    const taken = await feed.next(pending());
    expect(taken).toHaveLength(1_000);
    expect(taken.at(-1)!.id).toBe('m999');
    feed.push(makeMessage({ id: 'after' }));
    expect((await feed.next(pending())).map((m) => m.id)).toEqual(['after']);
  });
});
