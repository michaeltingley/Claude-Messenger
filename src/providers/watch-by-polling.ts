import type { Message, Page } from '../core/types.js';
import { ProviderError } from '../core/errors.js';

/**
 * A message watch for a backend that can be searched but not subscribed to.
 *
 * Each scan asks for the matching messages timestamped after a floor and
 * delivers the ones it has not delivered yet. A message can reach the backend
 * after its own timestamp (a bridge reconnecting, a backlog syncing), so the
 * floor trails the start of the previous scan by `lateWindowMs`: a message
 * that arrives up to that late is still delivered, and one later than that is
 * missed. The floor follows this host's clock, never the messages'
 * timestamps, so a message dated in the future can't hide the ones after it.
 * It only moves forward, and delivered messages that fall below it are
 * forgotten, so memory stays bounded by the window.
 */
export interface WatchByPollingOptions {
  /** ISO 8601: deliver only messages timestamped strictly after this. */
  since: string;
  /** The wait between scans. */
  intervalMs: number;
  /**
   * One page of the matching messages timestamped strictly after
   * `dateAfter`, in any order; a page's `nextCursor` continues the scan.
   */
  fetchPage(request: { dateAfter: string; cursor?: string; signal: AbortSignal }): Promise<Page<Message>>;
  /** How late a message may reach the backend and still be delivered. */
  lateWindowMs?: number;
  /** The most pages one scan may take; past it the watch fails rather than skip messages. */
  maxPagesPerScan?: number;
}

export const DEFAULT_LATE_WINDOW_MS = 10 * 60_000;
export const DEFAULT_MAX_PAGES_PER_SCAN = 20;

/**
 * The matching messages as scans find them, each once, oldest first within a
 * scan. Ends when `signal` aborts, whether it is waiting between scans or on
 * the backend; a backend failure ends it with that error.
 */
export async function* watchByPolling(options: WatchByPollingOptions, signal: AbortSignal): AsyncGenerator<Message, void, undefined> {
  const lateWindowMs = options.lateWindowMs ?? DEFAULT_LATE_WINDOW_MS;
  const maxPages = options.maxPagesPerScan ?? DEFAULT_MAX_PAGES_PER_SCAN;
  let floor = Date.parse(options.since);
  if (Number.isNaN(floor)) throw new RangeError(`Not an ISO 8601 time: ${options.since}`);
  /** Delivered messages still above the floor: ID → timestamp. */
  const delivered = new Map<string, number>();

  const scan = async (dateAfter: string): Promise<Message[]> => {
    const found: Message[] = [];
    let cursor: string | undefined;
    for (let pages = 1; ; pages++) {
      const page = await options.fetchPage({ dateAfter, ...(cursor !== undefined && { cursor }), signal });
      found.push(...page.items);
      if (!page.hasMore) return found;
      if (page.nextCursor === undefined) {
        throw new ProviderError(`The backend reported more messages after ${dateAfter} but gave no cursor to fetch them.`);
      }
      if (pages === maxPages) {
        throw new ProviderError(
          `Too many messages to catch up on at once: more than ${maxPages} pages after ${dateAfter}. Watch from a later time.`,
        );
      }
      cursor = page.nextCursor;
    }
  };

  while (!signal.aborted) {
    const scanStart = Date.now();
    let found: Message[];
    try {
      found = await scan(new Date(floor).toISOString());
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    const fresh = found
      .map((message) => ({ message, at: Date.parse(message.timestamp) }))
      // A time that doesn't parse is NaN, which fails `> floor`: such a
      // message can't be placed in the window, so it is never delivered.
      .filter(({ message, at }) => at > floor && !delivered.has(message.id))
      .sort((a, b) => a.at - b.at);
    for (const { message, at } of fresh) {
      if (delivered.has(message.id)) continue; // listed twice in one scan
      if (signal.aborted) return;
      delivered.set(message.id, at);
      yield message;
    }
    floor = Math.max(floor, scanStart - lateWindowMs);
    for (const [id, at] of delivered) if (at <= floor) delivered.delete(id);
    await sleep(options.intervalMs, signal);
  }
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
