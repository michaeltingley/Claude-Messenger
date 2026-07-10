import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MessengerError } from '../core/errors.js';

/**
 * Sliding-window occurrence store behind the policy engine's rate limits.
 *
 * The port exists because rate-limit state must outlive the process for the
 * guarantee to mean anything: a long-running MCP server can keep it in
 * memory, but each CLI `send` is a fresh process, so the composition root
 * wires a file-backed window there. Implementations are synchronous so the
 * engine can check-and-reserve atomically within a JS turn; events are rare
 * and tiny.
 */
export interface RateWindow {
  /** Number of recorded events with timestamp strictly after `sinceMs`. */
  countSince(sinceMs: number): number;
  /** Record one event at `atMs`. May compact entries at or before `pruneBeforeMs`. */
  record(atMs: number, pruneBeforeMs: number): void;
}

export class MemoryRateWindow implements RateWindow {
  private timestamps: number[] = [];

  countSince(sinceMs: number): number {
    return this.timestamps.filter((t) => t > sinceMs).length;
  }

  record(atMs: number, pruneBeforeMs: number): void {
    this.timestamps = this.timestamps.filter((t) => t > pruneBeforeMs);
    this.timestamps.push(atMs);
  }
}

/** The rate limiter must fail CLOSED: this error denies the send. */
export class RateWindowUnavailableError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'rate_window_unavailable', options);
  }
}

/**
 * Append-only JSONL of epoch-millis, one event per line.
 *
 * Failure-mode design, in order of importance:
 * - Appends never truncate, so a crash or a concurrent writer cannot erase
 *   history (the previous truncate-and-rewrite design could zero the window
 *   mid-write, silently resetting the limit).
 * - A malformed line (torn write) is counted as an event NOW — corruption
 *   makes the limiter stricter, never looser.
 * - An unreadable file (permissions, it's a directory, ...) throws
 *   RateWindowUnavailableError, which callers surface as a denied send.
 * - Compaction runs only when the file accumulates far more lines than any
 *   window needs, and writes temp-then-rename so readers never observe a
 *   partial file. A concurrent append can lose at most that one race — at
 *   CLI-send frequency this is acceptable; correctness never depends on
 *   compaction happening.
 */
export class FileRateWindow implements RateWindow {
  static readonly COMPACT_THRESHOLD = 4096;

  constructor(private readonly path: string) {}

  private load(): number[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new RateWindowUnavailableError(
        `Cannot read rate-limit state at ${this.path}; refusing to send without it.`,
        { cause: err },
      );
    }
    const now = Date.now();
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = Number(line);
        return Number.isFinite(parsed) ? parsed : now; // torn line → fail closed
      });
  }

  countSince(sinceMs: number): number {
    return this.load().filter((t) => t > sinceMs).length;
  }

  record(atMs: number, pruneBeforeMs: number): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${atMs}\n`, 'utf8');
    this.maybeCompact(pruneBeforeMs);
  }

  private maybeCompact(pruneBeforeMs: number): void {
    let events: number[];
    try {
      events = this.load();
    } catch {
      return; // compaction is best-effort; the append already succeeded
    }
    if (events.length <= FileRateWindow.COMPACT_THRESHOLD) return;
    const kept = events.filter((t) => t > pruneBeforeMs);
    const tmp = join(dirname(this.path), `.${Date.now()}.rate.tmp`);
    try {
      writeFileSync(tmp, kept.map((t) => `${t}\n`).join(''), 'utf8');
      renameSync(tmp, this.path);
    } catch {
      // Leave the uncompacted file in place; it stays correct, just larger.
    }
  }
}
