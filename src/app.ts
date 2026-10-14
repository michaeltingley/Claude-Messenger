import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { Config, EndpointConfig } from './config.js';
import type { AccessRequester } from './core/access.js';
import type { Messenger } from './core/messenger.js';
import type { LanguageModel } from './core/model.js';
import type { AccountSignup } from './core/signup.js';
import type { ServerInfo } from './core/types.js';
import { MessengerError } from './core/errors.js';
import { BeeperAccessRequester } from './providers/beeper/access.js';
import { BeeperMessenger } from './providers/beeper/index.js';
import { BeeperAccountSignup } from './providers/beeper/signup.js';
import { ClaudeCodeModel } from './providers/claude-code/model.js';
import { GuardedAccessRequester } from './policy/access.js';
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
  checkConnection(): Promise<ServerInfo>;
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
    pollIntervalMs: config.beeperPollIntervalMs,
  });
  // File-backed send window: rate limits hold across process restarts
  // (every CLI invocation is a fresh process). Lives in stateDir, not
  // auditDir — pruning audit logs must never reset the rate limit.
  const engine = new PolicyEngine(policy, Date.now, new FileRateWindow(join(config.stateDir, 'send-window.jsonl')));
  return {
    messenger: new GuardedMessenger(provider, engine, new JsonlAuditLogger(config.auditDir)),
    probe: { checkConnection: () => provider.checkConnection() },
    policy,
    policySource: filePolicy ? 'file' : 'default',
  };
}

/**
 * The provider's approval flow, for `connect`, behind the guard that refuses
 * credentials this app can't keep. It needs only the endpoint: it runs before
 * any credential exists, and it is how one comes to exist.
 */
export function createAccessRequester(endpoint: EndpointConfig): AccessRequester {
  return new GuardedAccessRequester(new BeeperAccessRequester({ baseUrl: endpoint.beeperBaseUrl }));
}

/**
 * The provider's sign-up, for `signup`: an account of this app's own, for an
 * assistant that answers as itself. Like the approval flow, it needs only the
 * endpoint, which must be one of its own: signing up refuses one that is
 * signed in.
 */
export function createAccountSignup(endpoint: EndpointConfig): AccountSignup {
  return new BeeperAccountSignup({ baseUrl: endpoint.beeperBaseUrl });
}

/**
 * The Claude model automations write with unless told otherwise. A summary
 * or a draft doesn't need the largest model, and a smaller one spends less
 * of the subscription's usage limits.
 */
export const DEFAULT_LANGUAGE_MODEL = 'sonnet';

export interface LanguageModelOptions {
  /** Which Claude model writes, by alias (`sonnet`) or full name. Defaults to `DEFAULT_LANGUAGE_MODEL`. */
  model?: string;
}

/**
 * The model automations write with: Claude Code as installed and signed in
 * on this host, so it runs on the owner's Claude subscription, never an API
 * key. It is given no tools: it only ever writes text.
 */
export function createLanguageModel({ model = DEFAULT_LANGUAGE_MODEL }: LanguageModelOptions = {}): LanguageModel {
  return new ClaudeCodeModel({ model });
}
