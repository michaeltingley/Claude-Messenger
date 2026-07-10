import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileRateWindow, RateWindowUnavailableError } from '../src/policy/rate.js';

describe('FileRateWindow', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rate-window-'));
    path = join(dir, 'send-window.jsonl');
  });

  it('persists events across instances (fresh process semantics)', () => {
    new FileRateWindow(path).record(1_000, 0);
    new FileRateWindow(path).record(2_000, 0);
    expect(new FileRateWindow(path).countSince(0)).toBe(2);
    expect(new FileRateWindow(path).countSince(1_500)).toBe(1);
  });

  it('missing file counts as zero events', () => {
    expect(new FileRateWindow(path).countSince(0)).toBe(0);
  });

  it('fails CLOSED on a torn/corrupt line: counts it as an event now', () => {
    const window = new FileRateWindow(path);
    window.record(1_000, 0);
    appendFileSync(path, 'garbage-not-a-number\n');
    // The corrupt line is treated as happening now, so it always lands
    // inside the sliding window — corruption tightens the limit.
    expect(window.countSince(Date.now() - 3_600_000)).toBeGreaterThanOrEqual(1);
  });

  it('fails CLOSED when the file is unreadable: throws instead of returning 0', () => {
    mkdirSync(path); // a directory at the path makes readFileSync throw non-ENOENT
    expect(() => new FileRateWindow(path).countSince(0)).toThrow(RateWindowUnavailableError);
  });

  it('appends never truncate: concurrent-style interleaved records all survive', () => {
    const a = new FileRateWindow(path);
    const b = new FileRateWindow(path);
    a.record(1, 0);
    b.record(2, 0);
    a.record(3, 0);
    expect(new FileRateWindow(path).countSince(0)).toBe(3);
  });

  it('compacts old events past the threshold via atomic rename', () => {
    writeFileSync(path, Array.from({ length: FileRateWindow.COMPACT_THRESHOLD + 10 }, (_, i) => `${i + 1}\n`).join(''));
    const window = new FileRateWindow(path);
    window.record(999_999, 900_000); // prune everything at or before 900k
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThan(20);
    expect(window.countSince(900_000)).toBe(1); // only the new event remains in-window
  });
});
