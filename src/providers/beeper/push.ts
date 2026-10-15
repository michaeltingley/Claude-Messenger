import type BeeperDesktop from '@beeper/desktop-api';
import { z } from 'zod';
import type { MessageWatchQuery } from '../../core/types.js';
import { PushedMessages, type PushFeed } from '../push-feed.js';
import { parseOrUndefined } from './json.js';
import { toMessage } from './mapper.js';

export interface PushFeedOptions {
  /** The Client API's endpoint, as the messenger has it: the feed is `/v1/ws` beside it. */
  baseUrl: string;
  accessToken: string;
  /** Whose messages the watch asks for. */
  sender: MessageWatchQuery['sender'];
  /**
   * The wait before connecting again once a connection ends: `firstMs`,
   * doubled each time, up to `maxMs`; `firstMs` again after a connection
   * that held for `maxMs`.
   */
  retry?: { firstMs: number; maxMs: number };
}

const DEFAULT_RETRY = { firstMs: 1_000, maxMs: 60_000 };

/** The one subscription a watch asks for: every chat, since the owner can write in any. */
const SUBSCRIBE = JSON.stringify({ type: 'subscriptions.set', requestID: 'watch', chatIDs: ['*'] });

/**
 * A pushed message, as far as `toMessage` reads it, typed as Beeper's API
 * reference types its messages; but any `type` passes, since `toMessage`
 * reads one newer than this app as 'other'.
 */
const Entry = z
  .object({
    id: z.string(),
    accountID: z.string(),
    chatID: z.string(),
    senderID: z.string(),
    senderName: z.string().optional(),
    isSender: z.boolean().optional(),
    timestamp: z.string(),
    type: z.string().optional(),
    text: z.string().optional(),
    attachments: z
      .array(
        z
          .object({
            type: z.string(),
            fileName: z.string().optional(),
            mimeType: z.string().optional(),
            fileSize: z.number().optional(),
            isVoiceNote: z.boolean().optional(),
            isSticker: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    reactions: z.array(z.object({ reactionKey: z.string(), participantID: z.string() }).passthrough()).optional(),
    isUnread: z.boolean().optional(),
    isDeleted: z.boolean().optional(),
    isHidden: z.boolean().optional(),
    linkedMessageID: z.string().optional(),
  })
  .passthrough();

/**
 * Opens Beeper's push feed (`/v1/ws`) for one message watch: the messages
 * it asks for, as Beeper pushes them, until `signal` aborts.
 *
 * Beeper marks the feed experimental, and it pushes each change at most
 * once: nothing that changes while it is disconnected, and nothing Beeper
 * can't read yet when it changes, is ever pushed. So it only makes a watch
 * quicker, and the watch's scans deliver what it misses. Nothing about it
 * fails the watch, either: a Beeper without it, a connection refused or
 * lost, or a frame or message it can't read leaves the scans to deliver.
 * Each time a connection ends, it connects again, waiting longer after each
 * that fails.
 */
export function openPushFeed(options: PushFeedOptions, signal: AbortSignal): PushFeed {
  const feed = new Feed(options, signal);
  feed.connect();
  return feed.pushed;
}

class Feed {
  readonly pushed = new PushedMessages();
  private readonly retry: { firstMs: number; maxMs: number };
  private retryMs: number;
  private socket: WebSocket | undefined;
  /** When the current connection opened, by the monotonic clock. */
  private openedAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: PushFeedOptions,
    private readonly signal: AbortSignal,
  ) {
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.retryMs = this.retry.firstMs;
    signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  connect(): void {
    if (this.signal.aborted) return;
    let socket: WebSocket;
    try {
      // The token goes as a header, as on every other request: never in the URL.
      socket = new WebSocket(feedUrl(this.options.baseUrl), {
        headers: { authorization: `Bearer ${this.options.accessToken}` },
      });
    } catch {
      return; // A Node without WebSocket (before 22), or a base URL it can't make a feed address of: the scans deliver alone.
    }
    this.socket = socket;
    socket.addEventListener('open', () => (this.openedAt = performance.now()));
    socket.addEventListener('message', (event) => this.receive(socket, event.data));
    // A connection refused before it opens fires only `error` in Node's
    // WebSocket (undici 6), never `close`; one that ends once open fires
    // `close`, after `error` when it failed. Either is its end, taken once.
    socket.addEventListener('error', () => this.ended(socket));
    socket.addEventListener('close', () => this.ended(socket));
  }

  /** A frame from Beeper. Whatever it holds, nothing escapes: a listener's error would end the process. */
  private receive(socket: WebSocket, data: unknown): void {
    const frame = typeof data === 'string' ? parseOrUndefined(data) : undefined;
    if (!isRecord(frame)) return;
    if (frame.type === 'ready') {
      if (socket.readyState === WebSocket.OPEN) socket.send(SUBSCRIBE);
    } else if (frame.type === 'error') {
      // The subscription refused, most likely: start over, later.
      socket.close();
    } else if (frame.type === 'message.upserted' && Array.isArray(frame.entries)) {
      for (const entry of frame.entries) this.take(entry);
    }
  }

  /** A message Beeper pushed: held for the watch if it asks for it and reads as a message. */
  private take(entry: unknown): void {
    // Anyone else's message is let go unread: the watch doesn't ask for it.
    if (!isRecord(entry) || !fromSender(entry, this.options.sender)) return;
    const parsed = Entry.safeParse(entry);
    if (!parsed.success) return;
    try {
      // Every field toMessage reads was checked above.
      this.pushed.push(toMessage(parsed.data as unknown as BeeperDesktop.Message));
    } catch {
      // Left to the scans, which read it as a watch always has.
    }
  }

  /** A connection over, however it ended: the next one is due after the current wait. */
  private ended(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    if (this.signal.aborted) return;
    const held = this.openedAt !== undefined && performance.now() - this.openedAt >= this.retry.maxMs;
    this.openedAt = undefined;
    if (held) this.retryMs = this.retry.firstMs;
    const wait = this.retryMs;
    this.retryMs = Math.min(wait * 2, this.retry.maxMs);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  private stop(): void {
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
}

/** Where Beeper serves its feed: beside the API, on the WebSocket scheme that matches its own. */
function feedUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/ws`;
  return url;
}

/** Whether a pushed message is from whom a watch asks for, as Beeper's search reads `sender`. */
function fromSender(entry: Record<string, unknown>, sender: MessageWatchQuery['sender']): boolean {
  switch (sender) {
    case 'me':
      return entry.isSender === true;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
