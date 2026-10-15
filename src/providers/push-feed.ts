import type { Message } from '../core/types.js';

/**
 * A backend's push feed, as a message watch reads it: the messages the
 * backend pushed that the watch asks for, held until the watch takes them.
 *
 * A feed only makes a watch quicker. It may miss messages, and nothing about
 * it can fail the watch: the watch's scans deliver whatever it doesn't.
 */
export interface PushFeed {
  /**
   * What the feed has pushed since the watch last took it, as soon as there
   * is any; nothing, if `until` aborts first.
   */
  next(until: AbortSignal): Promise<Message[]>;
}

/** The most pushed messages held for a watch: past it, a push is dropped, and a scan delivers it. */
const MAX_HELD = 1_000;

/** The messages a provider's feed pushed, held for the watch that reads them. */
export class PushedMessages implements PushFeed {
  private held: Message[] = [];
  private arrived: (() => void) | undefined;

  /** Holds `message` for the watch, unless it holds as many as it may already. */
  push(message: Message): void {
    if (this.held.length >= MAX_HELD) return;
    this.held.push(message);
    this.arrived?.();
  }

  async next(until: AbortSignal): Promise<Message[]> {
    if (this.held.length === 0) await this.arrival(until);
    const taken = this.held;
    this.held = [];
    return taken;
  }

  /** Settles when a message is pushed, or `until` aborts, whichever comes first. */
  private arrival(until: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (until.aborted) return resolve();
      const done = () => {
        until.removeEventListener('abort', done);
        this.arrived = undefined;
        resolve();
      };
      until.addEventListener('abort', done, { once: true });
      this.arrived = done;
    });
  }
}
