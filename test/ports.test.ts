import { afterEach, describe, expect, it, vi } from 'vitest';
import { unusedPort } from './ports.js';

describe('unusedPort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never gives Beeper Desktop's port, which deploy/assistant-beeper.sh refuses, even when it comes up", async () => {
    // The first pick lands on 23373, the next on 26000.
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce((23_373 - 20_000) / 12_000)
      .mockReturnValueOnce(0.5);
    expect(await unusedPort()).toBe(26_000);
  });
});
