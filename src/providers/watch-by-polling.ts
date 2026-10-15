import type { Message, Page } from '../core/types.js';
import { BacklogTooLargeError, ProviderError } from '../core/errors.js';
import type { PushFeed } from './push-feed.js';

/**
 * A message watch for a backend that can be searched, whether or not it can
 * also push its messages as they come.
 *
 * Each scan asks for the matching messages timestamped after a floor and
 * delivers the ones it has not delivered yet. A message can reach the backend
 * after its own timestamp (a bridge reconnecting, a backlog syncing), so the
 * floor trails the start of the previous scan by `lateWindowMs`: a message
 * that arrives up to that late is still delivered, and one later than that is
 * missed. The floor follows this host's clock, never the messages'
 * timestamps, so a message dated in the future can't hide the ones after it;
 * that clock must agree with the network's to within the window, as NTP
 * keeps it. The floor only moves forward, so a clock stepped back repeats
 * nothing, and delivered messages that fall below it are forgotten, so
 * memory stays bounded by the window.
 *
 * A backend that can also push messages as they reach it (`push`) has what
 * it pushes between scans delivered at once, by the same rules, so a pushed
 * message the next scan finds again is not delivered twice. The scans go on
 * as without it: a push feed can miss messages, as Beeper's does while it
 * reconnects, and the scans find what it misses no later than they would
 * have found it anyway.
 */
export interface WatchByPollingOptions {
  /** ISO 8601: deliver only messages timestamped strictly after this. */
  since: string;
  /** The wait between scans, from 1 ms to the longest a timer can wait (about 24.8 days). */
  intervalMs: number;
  /**
   * One page of the matching messages timestamped strictly after
   * `dateAfter`, in any order; a page's `nextCursor` continues the scan.
   * `signal` belongs to this request alone and aborts when the watch does.
   */
  fetchPage(request: { dateAfter: string; cursor?: string; signal: AbortSignal }): Promise<Page<Message>>;
  /**
   * Opens the backend's push feed for this watch alone, when it has one.
   * `signal` aborts when the watch ends, however it ends, and the feed closes
   * with it.
   */
  push?: (signal: AbortSignal) => PushFeed;
  /** How late a message may reach the backend and still be delivered. */
  lateWindowMs?: number;
  /** The most pages one scan may take; past it the watch fails rather than skip messages. */
  maxPagesPerScan?: number;
}

const DEFAULT_LATE_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_PAGES_PER_SCAN = 50;
/** Node's timers hold at most this; a longer wait fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Message IDs are unique within a chat, which is all every backend promises. */
const keyOf = (message: Message) => `${message.chatId}\u0000${message.id}`;

/**
 * The matching messages as scans find them or the backend pushes them, each
 * once, oldest first within a scan or a push. Ends when `signal` aborts,
 * whether it is waiting between scans or on the backend; a backend failure
 * ends it with that error.
 */
export async function* watchByPolling(options: WatchByPollingOptions, signal: AbortSignal): AsyncGenerator<Message, void, undefined> {
  const lateWindowMs = options.lateWindowMs ?? DEFAULT_LATE_WINDOW_MS;
  const maxPages = options.maxPagesPerScan ?? DEFAULT_MAX_PAGES_PER_SCAN;
  let floor = Date.parse(options.since);
  if (Number.isNaN(floor)) throw new RangeError(`Not an ISO 8601 time: ${options.since}`);
  // NaN and 0 fail this too: a timer would fire at once, and the watch would ask without pause.
  if (!(options.intervalMs >= 1 && options.intervalMs <= MAX_TIMER_MS)) {
    throw new RangeError(`intervalMs must be from 1 to ${MAX_TIMER_MS}, not ${options.intervalMs}`);
  }
  /** Delivered messages still above the floor: key → timestamp. */
  const delivered = new Map<string, number>();
  // The watch's own signal: aborted with the caller's, and as the watch ends,
  // however it ends, which closes its push feed. What the watch waits on
  // listens to this one, so the caller's never holds more than one listener.
  const watch = new AbortController();
  const stop = () => watch.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();

  const scan = async (dateAfter: string): Promise<Message[]> => {
    const found: Message[] = [];
    let cursor: string | undefined;
    for (let pages = 1; ; pages++) {
      const request = { dateAfter, ...(cursor !== undefined && { cursor }) };
      const page = await withOwnSignal(watch.signal, (own) => options.fetchPage({ ...request, signal: own }));
      found.push(...page.items);
      if (!page.hasMore) return found;
      if (page.nextCursor === undefined) {
        throw new ProviderError(`The backend reported more messages after ${dateAfter} but gave no cursor to fetch them.`);
      }
      if (pages === maxPages) {
        throw new BacklogTooLargeError(
          `More than ${found.length} messages to catch up on after ${dateAfter}. Watch from a later time.`,
        );
      }
      cursor = page.nextCursor;
    }
  };

  /** Those of `messages` not delivered yet and dated after the floor, oldest first, each marked delivered as it is handed on. */
  function* deliver(messages: Message[]): Generator<Message, void, undefined> {
    const fresh = messages
      .map((message) => ({ message, key: keyOf(message), at: Date.parse(message.timestamp) }))
      // A time that doesn't parse is NaN, which fails `> floor`: such a
      // message can't be placed in the window, so it is never delivered.
      .filter(({ key, at }) => at > floor && !delivered.has(key))
      .sort((a, b) => a.at - b.at);
    for (const { message, key, at } of fresh) {
      if (delivered.has(key)) continue; // listed twice in one scan or push
      if (watch.signal.aborted) return;
      delivered.set(key, at);
      yield message;
    }
  }

  /**
   * What `feed` pushes until the next scan is due, `intervalMs` from now, as
   * it pushes it. A timer measures the wait, not the clock, so a clock
   * stepped back doesn't hold the next scan off.
   */
  async function* pushedUntilDue(feed: PushFeed): AsyncGenerator<Message, void, undefined> {
    const due = new AbortController();
    const timer = setTimeout(() => due.abort(), options.intervalMs);
    const end = () => due.abort();
    watch.signal.addEventListener('abort', end, { once: true });
    if (watch.signal.aborted) end();
    try {
      while (!due.signal.aborted) yield* deliver(await feed.next(due.signal));
    } finally {
      clearTimeout(timer);
      watch.signal.removeEventListener('abort', end);
    }
  }

  try {
    const feed = options.push?.(watch.signal) ?? NO_PUSH;
    while (!watch.signal.aborted) {
      const scanStart = Date.now();
      let found: Message[];
      try {
        found = await scan(new Date(floor).toISOString());
      } catch (err) {
        if (watch.signal.aborted) return;
        throw err;
      }
      yield* deliver(found);
      floor = Math.max(floor, scanStart - lateWindowMs);
      for (const [key, at] of delivered) if (at <= floor) delivered.delete(key);
      // Until the next scan, what the backend pushes, as it pushes it.
      yield* pushedUntilDue(feed);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    watch.abort();
  }
}

/** A backend that pushes nothing: the wait for the next scan is only a wait. */
const NO_PUSH: PushFeed = {
  next: (until) =>
    new Promise((resolve) => {
      if (until.aborted) return resolve([]);
      until.addEventListener('abort', () => resolve([]), { once: true });
    }),
};

/**
 * Runs one backend request under a signal of its own that aborts with
 * `signal`. An HTTP client may attach a listener to the signal it is given
 * and never remove it; on the watch's signal, which lives as long as the
 * watch, one would pile up per request.
 */
async function withOwnSignal<T>(signal: AbortSignal, run: (own: AbortSignal) => Promise<T>): Promise<T> {
  const own = new AbortController();
  const abort = () => own.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await run(own.signal);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
