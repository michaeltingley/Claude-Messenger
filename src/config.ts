import { z } from 'zod';

/**
 * All runtime configuration comes from the environment (plus an optional
 * .env file loaded by the CLI entrypoint). The same config works for every
 * deployment topology — local Beeper Desktop, a tunnel to it, or a headless
 * Beeper Server on a VPS — because they all speak the same Client API.
 */
const ConfigSchema = z.object({
  /** Token minted in Beeper (Settings → Integrations → Approved connections). */
  BEEPER_ACCESS_TOKEN: z.string().min(1, 'BEEPER_ACCESS_TOKEN is required'),
  /** Where the Beeper Client API is reachable from this process. */
  BEEPER_BASE_URL: z.string().url().default('http://localhost:23373'),
  CLAUDE_MESSENGER_POLICY: z.string().default('./policy.json'),
  CLAUDE_MESSENGER_AUDIT_DIR: z.string().default('./audit'),
});

export interface Config {
  beeperAccessToken: string;
  beeperBaseUrl: string;
  policyPath: string;
  auditDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `Invalid configuration — ${issues}. Copy .env.example to .env and fill it in (see docs/SETUP.md).`,
    );
  }
  return {
    beeperAccessToken: parsed.data.BEEPER_ACCESS_TOKEN,
    beeperBaseUrl: parsed.data.BEEPER_BASE_URL,
    policyPath: parsed.data.CLAUDE_MESSENGER_POLICY,
    auditDir: parsed.data.CLAUDE_MESSENGER_AUDIT_DIR,
  };
}
