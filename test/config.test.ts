import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadConfigIn } from '../src/config.js';

const env = (extra: Record<string, string> = {}) => ({ BEEPER_ACCESS_TOKEN: 'token', ...extra });

describe('loadConfig: BEEPER_POLL_INTERVAL_MS', () => {
  it('defaults to 5 seconds, also when set but left empty', () => {
    expect(loadConfig(env()).beeperPollIntervalMs).toBe(5_000);
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '' })).beeperPollIntervalMs).toBe(5_000);
  });

  it('takes a whole number of milliseconds from 1000 to 60000', () => {
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '1000' })).beeperPollIntervalMs).toBe(1_000);
    expect(loadConfig(env({ BEEPER_POLL_INTERVAL_MS: '60000' })).beeperPollIntervalMs).toBe(60_000);
  });

  it.each(['999', '60001', '2.5', 'often'])('refuses %j, naming the variable', (value) => {
    expect(() => loadConfig(env({ BEEPER_POLL_INTERVAL_MS: value }))).toThrow(/BEEPER_POLL_INTERVAL_MS/);
  });
});

describe('loadConfigIn', () => {
  const withDir = async (envFile: string | undefined, run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-messenger-config-'));
    try {
      if (envFile !== undefined) await writeFile(join(dir, '.env'), envFile);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("reads the directory's .env, taking its relative paths from the directory", () =>
    withDir('BEEPER_ACCESS_TOKEN=its-own\nBEEPER_BASE_URL=http://127.0.0.1:23374\nCLAUDE_MESSENGER_AUDIT_DIR=/var/log/its-audit\n', async (dir) => {
      expect(await loadConfigIn(dir)).toEqual({
        beeperAccessToken: 'its-own',
        beeperBaseUrl: 'http://127.0.0.1:23374',
        beeperPollIntervalMs: 5_000,
        policyPath: join(dir, 'policy.json'),
        auditDir: '/var/log/its-audit',
        stateDir: join(dir, 'state'),
      });
    }));

  it("never takes what its .env leaves out from this process's environment, another account's token above all", async () => {
    const saved = { ...process.env };
    process.env.BEEPER_ACCESS_TOKEN = 'the-owners-token';
    process.env.CLAUDE_MESSENGER_POLICY = '/owner/policy.json';
    try {
      await withDir('BEEPER_ACCESS_TOKEN=its-own\n', async (dir) => {
        expect(await loadConfigIn(dir)).toMatchObject({ beeperAccessToken: 'its-own', policyPath: join(dir, 'policy.json') });
      });
      await withDir('BEEPER_BASE_URL=http://127.0.0.1:23374\n', async (dir) => {
        await expect(loadConfigIn(dir)).rejects.toThrow(`${join(dir, '.env')}: Invalid configuration — BEEPER_ACCESS_TOKEN`);
      });
    } finally {
      process.env = saved;
    }
  });

  it('says which file it could not read', () =>
    withDir(undefined, async (dir) => {
      await expect(loadConfigIn(dir)).rejects.toThrow(`${join(dir, '.env')}: ENOENT`);
    }));
});
