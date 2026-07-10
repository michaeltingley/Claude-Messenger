import { z } from 'zod';
import { MemoryRateWindow, type RateWindow } from './rate.js';

/**
 * Local permission layer.
 *
 * Backend tokens (Beeper access tokens, Matrix access tokens) are
 * all-or-nothing: anyone holding one can read everything and message anyone.
 * The policy layer narrows that down to what the user has actually granted
 * Claude, enforced in-process before any provider call is made.
 *
 * Defaults are deliberately conservative about actions: no sends, no state
 * changes. Reads default to everything (accountAllowlist '*') — narrowing
 * reads is opt-in via the allowlist/denylist.
 */

const starOrList = z.union([z.literal('*'), z.array(z.string())]);

export const PolicySchema = z.object({
  version: z.literal(1),
  capabilities: z
    .object({
      /** List/search chats and messages. */
      read: z.boolean().default(true),
      /** Send messages as the user. */
      send: z.boolean().default(false),
      /** Mark chats read (visible to other people via read receipts). */
      markRead: z.boolean().default(false),
    })
    .default({}),
  read: z
    .object({
      /** Accounts Claude may read, '*' for all. */
      accountAllowlist: starOrList.default('*'),
      /** Chats Claude must never see, regardless of allowlists. */
      chatDenylist: z.array(z.string()).default([]),
    })
    .default({}),
  send: z
    .object({
      /**
       * Chats Claude may send to. '*' is allowed but discouraged; the
       * intended shape is an explicit list of chat IDs.
       */
      chatAllowlist: starOrList.default([]),
      maxMessagesPerHour: z.number().int().positive().default(10),
      maxCharsPerMessage: z.number().int().positive().default(2000),
    })
    .default({}),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({ version: 1 });

export function parsePolicy(raw: unknown): Policy {
  return PolicySchema.parse(raw);
}

/**
 * Every rule that can deny an action. These IDs are user-facing contract:
 * MCP errors, CLI output, and audit entries all name them so the user knows
 * which policy.json knob to change.
 */
export type PolicyRule =
  | 'capabilities.read'
  | 'capabilities.send'
  | 'capabilities.markRead'
  | 'read.accountAllowlist'
  | 'read.chatDenylist'
  | 'send.chatAllowlist'
  | 'send.maxCharsPerMessage'
  | 'send.maxMessagesPerHour';

/**
 * Send is deliberately absent: a send decision is only obtainable via
 * reserveSend(), which consumes a rate slot atomically. A pure send check
 * would invite check-then-dispatch code whose rate accounting never
 * increments.
 */
export type PolicyAction =
  | { kind: 'checkConnection' }
  | { kind: 'listAccounts' }
  | { kind: 'read'; chatId?: string; accountId?: string }
  | { kind: 'markRead'; chatId: string };

export type Decision = { allowed: true } | { allowed: false; rule: PolicyRule; reason: string };

const deny = (rule: PolicyRule, reason: string): Decision => ({ allowed: false, rule, reason });
const ALLOW: Decision = { allowed: true };

function inList(list: '*' | string[], value: string | undefined): boolean {
  if (list === '*') return true;
  return value !== undefined && list.includes(value);
}

/**
 * Decision engine: no provider knowledge, no direct I/O. The clock and the
 * rate-limit store are injected — tests control time, and the composition
 * root picks a persistent RateWindow so limits survive process restarts
 * (each CLI `send` is a fresh process).
 */
export class PolicyEngine {
  constructor(
    readonly policy: Policy,
    private readonly now: () => number = Date.now,
    private readonly sendWindow: RateWindow = new MemoryRateWindow(),
  ) {}

  check(action: PolicyAction): Decision {
    switch (action.kind) {
      case 'checkConnection':
      case 'listAccounts':
        return ALLOW;
      case 'read':
        return this.checkRead(action);
      case 'markRead':
        return this.checkMarkRead(action);
    }
  }

  /**
   * Check a send AND consume a rate-limit slot in one synchronous step.
   * Check-then-record-later would let concurrent in-flight sends all pass
   * the gate; reserving at decision time closes that window (a failed
   * dispatch still consumes its slot — the limiter fails closed).
   */
  private static readonly SEND_WINDOW_MS = 3_600_000;

  reserveSend(action: { chatId: string; textLength: number }): Decision {
    const decision = this.checkSend(action);
    if (decision.allowed) {
      const now = this.now();
      this.sendWindow.record(now, now - PolicyEngine.SEND_WINDOW_MS);
    }
    return decision;
  }

  private checkRead(action: { chatId?: string; accountId?: string }): Decision {
    if (!this.policy.capabilities.read) {
      return deny('capabilities.read', 'Reading is disabled by policy.');
    }
    if (action.chatId !== undefined && this.policy.read.chatDenylist.includes(action.chatId)) {
      return deny('read.chatDenylist', `Chat ${action.chatId} is denylisted.`);
    }
    if (action.accountId !== undefined && !inList(this.policy.read.accountAllowlist, action.accountId)) {
      return deny('read.accountAllowlist', `Account ${action.accountId} is not allowlisted for reading.`);
    }
    return ALLOW;
  }

  private checkSend(action: { chatId: string; textLength: number }): Decision {
    if (!this.policy.capabilities.send) {
      return deny(
        'capabilities.send',
        'Sending is disabled by policy. Enable capabilities.send and allowlist the chat to permit it.',
      );
    }
    if (this.policy.read.chatDenylist.includes(action.chatId)) {
      return deny('read.chatDenylist', `Chat ${action.chatId} is denylisted.`);
    }
    if (!inList(this.policy.send.chatAllowlist, action.chatId)) {
      return deny('send.chatAllowlist', `Chat ${action.chatId} is not allowlisted for sending.`);
    }
    if (action.textLength > this.policy.send.maxCharsPerMessage) {
      return deny(
        'send.maxCharsPerMessage',
        `Message is ${action.textLength} chars; limit is ${this.policy.send.maxCharsPerMessage}.`,
      );
    }
    const hourAgo = this.now() - PolicyEngine.SEND_WINDOW_MS;
    if (this.sendWindow.countSince(hourAgo) >= this.policy.send.maxMessagesPerHour) {
      return deny(
        'send.maxMessagesPerHour',
        `Rate limit reached: ${this.policy.send.maxMessagesPerHour} sends/hour.`,
      );
    }
    return ALLOW;
  }

  private checkMarkRead(action: { chatId: string }): Decision {
    if (!this.policy.capabilities.markRead) {
      return deny('capabilities.markRead', 'Marking chats read is disabled by policy.');
    }
    if (this.policy.read.chatDenylist.includes(action.chatId)) {
      return deny('read.chatDenylist', `Chat ${action.chatId} is denylisted.`);
    }
    return ALLOW;
  }

  /**
   * Canonical visibility predicate — defined as "would a read of this
   * chat/account be allowed", so pre-call checks and post-fetch filtering
   * can never disagree.
   */
  chatVisible(chat: { id: string; accountId: string }): boolean {
    return this.check({ kind: 'read', chatId: chat.id, accountId: chat.accountId }).allowed;
  }

  /** True when the account may be shown to Claude at all. */
  accountVisible(accountId: string): boolean {
    return this.check({ kind: 'read', accountId }).allowed;
  }
}
