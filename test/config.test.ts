import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const env = (extra: Record<string, string> = {}) => ({ BEEPER_ACCESS_TOKEN: 'token', ...extra });

describe('loadConfig: BEEPER_POLL_INTERVAL_MS', () => {
  it('defaults to 5 seconds, also when set but left empty, as a .env from .env.example has it', () => {
    expect(loadConfig(env()).beeperPollIntervalMs).toBe(5_000);
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '' })).beeperPollIntervalMs).toBe(5_000);
  });

  it('takes a whole number of milliseconds from 100 to 60000', () => {
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '100' })).beeperPollIntervalMs).toBe(100);
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '60000' })).beeperPollIntervalMs).toBe(60_000);
  });

  it.each(['99', '60001', '2.5', 'often'])('refuses %j, naming the variable', (value) => {
    expect(() => loadConfig(env({ BEEPER_POLL_INTERVAL_MS: value }))).toThrow(/BEEPER_POLL_INTERVAL_MS/);
  });
});
