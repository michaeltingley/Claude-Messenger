import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Page } from '../src/core/types.js';
import { ProviderError } from '../src/core/errors.js';
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
  return { stop, state, finished, ids: () => got.map((m) => m.id) };
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
    expect(watch.state.error).toBeInstanceOf(ProviderError);
    expect(String(watch.state.error)).toMatch(/Too many messages to catch up on at once: more than 2 pages after .*Watch from a later time/);
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
});
