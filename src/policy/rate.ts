import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sliding-window occurrence store behind the policy engine's rate limits.
 *
 * The port exists because rate-limit state must outlive the process for the
 * guarantee to mean anything: a long-running MCP server can keep it in
 * memory, but each CLI `send` is a fresh process, so the composition root
 * wires a file-backed window there. Implementations are synchronous — the
 * engine stays free of async plumbing and events are rare and tiny.
 */
export interface RateWindow {
  /** Number of recorded events with timestamp strictly after `sinceMs`. */
  countSince(sinceMs: number): number;
  /** Record one event at `atMs`. May prune entries at or before `pruneBeforeMs`. */
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

/**
 * One JSON array of epoch-millis in a single file. Reads and rewrites the
 * whole file per operation — correct and simple at rate-limit scale (tens of
 * events per hour). A corrupt or missing file counts as empty rather than
 * failing open loudly: the next record() rewrites it.
 */
export class FileRateWindow implements RateWindow {
  constructor(private readonly path: string) {}

  private load(): number[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : [];
    } catch {
      return [];
    }
  }

  countSince(sinceMs: number): number {
    return this.load().filter((t) => t > sinceMs).length;
  }

  record(atMs: number, pruneBeforeMs: number): void {
    const kept = this.load().filter((t) => t > pruneBeforeMs);
    kept.push(atMs);
    mkdirSync(dirname(this.path), { recursive: true });
    // Single write() of the full payload keeps concurrent senders from
    // interleaving partial content; last writer wins, which at worst
    // undercounts by one concurrent event.
    const fd = openSync(this.path, 'w');
    try {
      writeSync(fd, JSON.stringify(kept));
    } finally {
      closeSync(fd);
    }
  }
}
