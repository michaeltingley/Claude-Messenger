import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import type { Messenger } from './core/messenger.js';
import { BeeperMessenger } from './providers/beeper/index.js';
import { JsonlAuditLogger } from './policy/audit.js';
import { GuardedMessenger } from './policy/guarded.js';
import { DEFAULT_POLICY, parsePolicy, PolicyEngine, type Policy } from './policy/policy.js';

/**
 * Composition root: config → provider → policy → guarded messenger.
 * A missing policy file falls back to the conservative default (read-only).
 */
export interface App {
  messenger: Messenger;
  /** Unguarded provider — used only by `doctor` for connectivity checks. */
  raw: Messenger;
  policy: Policy;
  policySource: 'file' | 'default';
}

export async function loadPolicyFile(path: string): Promise<Policy | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parsePolicy(JSON.parse(text));
}

export async function createApp(config: Config): Promise<App> {
  const filePolicy = await loadPolicyFile(config.policyPath);
  const policy = filePolicy ?? DEFAULT_POLICY;
  const raw = new BeeperMessenger({
    accessToken: config.beeperAccessToken,
    baseUrl: config.beeperBaseUrl,
  });
  const messenger = new GuardedMessenger(
    raw,
    new PolicyEngine(policy),
    new JsonlAuditLogger(config.auditDir),
  );
  return { messenger, raw, policy, policySource: filePolicy ? 'file' : 'default' };
}
