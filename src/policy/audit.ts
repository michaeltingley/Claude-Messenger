import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MessengerError } from '../core/errors.js';

/**
 * Append-only audit trail of every action Claude attempts.
 *
 * Content policy: outbound message text IS recorded (the user must be able
 * to review exactly what was said on their behalf), but for an account of
 * the assistant's own, which writes from what it read and sends only to the
 * owner: of its messages, only the length is (`GuardedMessengerOptions`).
 * Message content that was merely read is NOT recorded — only which
 * chats/queries were accessed, and which messages a watch handed on, by ID.
 * A failure is recorded by its code, never its message (see `errorCode`).
 */
export interface AuditEntry {
  ts: string;
  action: string;
  decision: 'allowed' | 'denied';
  /** Policy rule that denied the action, when denied. */
  rule?: string;
  /**
   * Mutations write two entries: 'intent' before dispatch (mandatory — no
   * side effect happens without it) and 'outcome' after (best-effort).
   * Watches write the same two, with a mandatory 'delivery' entry between
   * them for each message handed on, naming it but never holding its text.
   * Reads write a single entry with no stage.
   */
  stage?: 'intent' | 'delivery' | 'outcome';
  /** Pairs the entries of one mutation or watch under concurrency. */
  opId?: string;
  outcome?: 'ok' | 'error';
  /** What kind of failure an error outcome was, from `errorCode`. */
  error?: string;
  /** Redacted parameters: chat/account IDs, queries, sent text or its length. */
  context?: Record<string, unknown>;
}

export interface AuditLogger {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * What the audit records of a failure: its `MessengerError` code, such as
 * `provider_error` or `not_found`, or `internal_error` for any other error.
 * Never its message: a provider's error text comes from outside this program
 * (an error body, a parser's excerpt of what it read), so it can quote a
 * message that was read. Whoever made the call still gets the whole error.
 */
export function errorCode(err: unknown): string {
  return err instanceof MessengerError ? err.code : 'internal_error';
}

/** One JSONL file per day under `dir`. */
export class JsonlAuditLogger implements AuditLogger {
  private dirReady: Promise<unknown> | undefined;

  constructor(private readonly dir: string) {}

  async record(entry: AuditEntry): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true });
    await this.dirReady;
    const day = entry.ts.slice(0, 10);
    await appendFile(join(this.dir, `audit-${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  }
}

/** In-memory logger for tests and dry runs. */
export class MemoryAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
