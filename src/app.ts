import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Messenger } from './core/messenger.js';
import type { ServerInfo } from './core/types.js';
import { MessengerError } from './core/errors.js';
import { BeeperMessenger } from './providers/beeper/index.js';
import { JsonlAuditLogger } from './policy/audit.js';
import { GuardedMessenger } from './policy/guarded.js';
import { DEFAULT_POLICY, parsePolicy, PolicyEngine, type Policy } from './policy/policy.js';
import { FileRateWindow } from './policy/rate.js';

/**
 * Composition root: config → provider → policy → guarded messenger.
 * A missing policy file falls back to the conservative default; a PRESENT
 * but broken policy file is a hard, clearly-attributed error — silently
 * falling back could discard the user's denylist.
 */

/**
 * Connectivity-only view of the backend for diagnostics. Deliberately NOT a
 * Messenger: the unguarded provider must never be reachable from command
 * code, where a one-word `raw` destructure would bypass policy and audit.
 */
export interface ConnectivityProbe {
  whoami(): Promise<ServerInfo>;
}

export interface App {
  messenger: Messenger;
  probe: ConnectivityProbe;
  policy: Policy;
  policySource: 'file' | 'default';
}

export class PolicyFileError extends MessengerError {
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(
      `Policy file ${path} is invalid: ${detail} — fix the file or remove it to fall back to the read-only default.`,
      'policy_file_invalid',
      options,
    );
  }
}

export async function loadPolicyFile(path: string): Promise<Policy | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PolicyFileError(path, `cannot read it (${(err as Error).message})`, { cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PolicyFileError(path, `not valid JSON (${(err as Error).message})`, { cause: err });
  }
  try {
    return parsePolicy(raw);
  } catch (err) {
    const detail =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : String(err);
    throw new PolicyFileError(path, detail, { cause: err });
  }
}

export async function createApp(config: Config): Promise<App> {
  const filePolicy = await loadPolicyFile(config.policyPath);
  const policy = filePolicy ?? DEFAULT_POLICY;
  const provider = new BeeperMessenger({
    accessToken: config.beeperAccessToken,
    baseUrl: config.beeperBaseUrl,
  });
  // File-backed send window: rate limits hold across process restarts
  // (every CLI invocation is a fresh process).
  const engine = new PolicyEngine(policy, Date.now, new FileRateWindow(join(config.auditDir, 'send-window.jsonl')));
  return {
    messenger: new GuardedMessenger(provider, engine, new JsonlAuditLogger(config.auditDir)),
    probe: { whoami: () => provider.whoami() },
    policy,
    policySource: filePolicy ? 'file' : 'default',
  };
}
