import { randomUUID } from 'node:crypto';
import type { Messenger } from '../core/messenger.js';
import type {
  Account,
  Chat,
  ChatQuery,
  Message,
  MessageListQuery,
  MessageSearchQuery,
  MessageWatchQuery,
  Page,
  SendMessageInput,
  SendMessageResult,
  ServerInfo,
} from '../core/types.js';
import { PolicyDeniedError } from '../core/errors.js';
import { errorCode, type AuditLogger } from './audit.js';
import type { Decision, PolicyEngine, PolicyRule } from './policy.js';

/**
 * The only Messenger the tool layer (MCP, CLI, automations) is ever handed.
 *
 * Invariants this class owns:
 * - Every action is policy-checked before the provider is called, and every
 *   decision (allowed or denied, wherever it is made) lands in the audit log
 *   with its true rule name.
 * - Read results are filtered so denylisted chats and non-allowlisted
 *   accounts never reach Claude's context at all.
 * - Mutations are audited as INTENT before dispatch — if the audit log
 *   cannot be written, the mutation does not happen (no unaudited sends).
 *   The post-dispatch OUTCOME entry is best-effort: its failure must not
 *   turn an already-delivered send into a reported error, or a retry would
 *   message a real person twice.
 * - Watches get the same filtering as reads, message by message, and the
 *   same audit shape as mutations, plus a DELIVERY entry for each message
 *   before it is handed on: no message reaches the caller unaudited.
 */
export class GuardedMessenger implements Messenger {
  constructor(
    private readonly inner: Messenger,
    private readonly engine: PolicyEngine,
    private readonly audit: AuditLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async recordDenied(
    action: string,
    rule: PolicyRule,
    context: Record<string, unknown>,
    reason: string,
  ): Promise<never> {
    try {
      await this.audit.record({
        ts: this.now().toISOString(),
        action,
        decision: 'denied',
        rule,
        context,
      });
    } catch {
      // A failing audit log must not mask the denial itself.
    }
    throw new PolicyDeniedError(reason, rule);
  }

  /** Reads: one audit entry after completion; audit failure fails the read. */
  private async guardRead<T>(
    decision: Decision,
    name: string,
    context: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!decision.allowed) {
      return this.recordDenied(name, decision.rule, context, decision.reason);
    }
    try {
      const result = await run();
      await this.audit.record({
        ts: this.now().toISOString(),
        action: name,
        decision: 'allowed',
        outcome: 'ok',
        context,
      });
      return result;
    } catch (err) {
      await this.audit
        .record({
          ts: this.now().toISOString(),
          action: name,
          decision: 'allowed',
          outcome: 'error',
          error: errorCode(err),
          context,
        })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Mutations: intent entry BEFORE dispatch (mandatory — abort if it cannot
   * be written), outcome entry after (best-effort). Both entries share an
   * opId so concurrent mutations can be paired forensically, and the
   * outcome carries provider result fields (e.g. pendingMessageId) so the
   * audit trail joins to the delivered message.
   */
  private async guardMutation<T>(
    decision: Decision,
    name: string,
    context: Record<string, unknown>,
    run: () => Promise<T>,
    outcomeContext?: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    if (!decision.allowed) {
      return this.recordDenied(name, decision.rule, context, decision.reason);
    }
    const opId = randomUUID();
    await this.audit.record({
      ts: this.now().toISOString(),
      action: name,
      decision: 'allowed',
      stage: 'intent',
      opId,
      context,
    });
    let result: T;
    try {
      result = await run();
    } catch (err) {
      await this.audit
        .record({
          ts: this.now().toISOString(),
          action: name,
          decision: 'allowed',
          stage: 'outcome',
          opId,
          outcome: 'error',
          error: errorCode(err),
          context,
        })
        .catch(() => undefined);
      throw err;
    }
    await this.audit
      .record({
        ts: this.now().toISOString(),
        action: name,
        decision: 'allowed',
        stage: 'outcome',
        opId,
        outcome: 'ok',
        context: { ...context, ...outcomeContext?.(result) },
      })
      .catch(() => undefined); // the send happened; intent is on record
    return result;
  }

  checkConnection(): Promise<ServerInfo> {
    return this.guardRead(this.engine.check({ kind: 'checkConnection' }), 'checkConnection', {}, () =>
      this.inner.checkConnection(),
    );
  }

  listAccounts(): Promise<Account[]> {
    return this.guardRead(this.engine.check({ kind: 'listAccounts' }), 'listAccounts', {}, async () => {
      const accounts = await this.inner.listAccounts();
      return accounts.filter((a) => this.engine.accountVisible(a.id));
    });
  }

  searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    return this.guardRead(
      this.engine.check({ kind: 'read' }),
      'searchChats',
      { query: query?.query, type: query?.type },
      async () => {
        const page = await this.inner.searchChats(query);
        return { ...page, items: page.items.filter((c) => this.engine.chatVisible(c)) };
      },
    );
  }

  async getChat(chatId: string): Promise<Chat> {
    const context = { chatId };
    const chat = await this.guardRead(
      this.engine.check({ kind: 'read', chatId }),
      'getChat',
      context,
      () => this.inner.getChat(chatId),
    );
    // Account-level visibility is only knowable after the fetch; record the
    // denial with its true rule rather than leaking the chat.
    const post = this.engine.checkVisible({ chatId: chat.id, accountId: chat.accountId });
    if (!post.allowed) {
      return this.recordDenied('getChat', post.rule, context, post.reason);
    }
    return chat;
  }

  async listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    const context = { chatId };
    const page = await this.guardRead(
      this.engine.check({ kind: 'read', chatId }),
      'listMessages',
      context,
      () => this.inner.listMessages(chatId, query),
    );
    const visible = page.items.filter((m) =>
      this.engine.chatVisible({ id: m.chatId, accountId: m.accountId }),
    );
    // All messages in a chat share an account; if filtering emptied a
    // non-empty page the account is hidden — deny explicitly instead of
    // returning a silent empty page.
    if (visible.length === 0 && page.items.length > 0) {
      const sample = page.items[0]!;
      const post = this.engine.checkVisible({ chatId: sample.chatId, accountId: sample.accountId });
      if (!post.allowed) {
        return this.recordDenied('listMessages', post.rule, context, post.reason);
      }
    }
    return { ...page, items: visible };
  }

  searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    return this.guardRead(
      this.engine.check({ kind: 'read' }),
      'searchMessages',
      { query: query.query, chatIds: query.chatIds, accountIds: query.accountIds },
      async () => {
        const page = await this.inner.searchMessages(query);
        return {
          ...page,
          items: page.items.filter((m) => this.engine.chatVisible({ id: m.chatId, accountId: m.accountId })),
        };
      },
    );
  }

  /**
   * Intent before the provider is asked (mandatory), a delivery entry naming
   * the chat and message before each one is handed on (mandatory, content
   * never), and the outcome when the watch ends (best-effort). All share an
   * opId. Idle polls write nothing, so a watch left running for days adds
   * an entry per delivered message rather than per poll.
   *
   * A watch for the user's own messages hands on nothing else, whatever the
   * provider returns: what other people write must never reach an
   * automation that acts on the user's words.
   */
  async *watchMessages(query: MessageWatchQuery, signal: AbortSignal): AsyncGenerator<Message, void, undefined> {
    const name = 'watchMessages';
    const context = { sender: query.sender, since: query.since };
    const decision = this.engine.check({ kind: 'read' });
    if (!decision.allowed) {
      await this.recordDenied(name, decision.rule, context, decision.reason);
    }
    const opId = randomUUID();
    await this.audit.record({
      ts: this.now().toISOString(),
      action: name,
      decision: 'allowed',
      stage: 'intent',
      opId,
      context,
    });
    let failure: unknown;
    try {
      for await (const message of this.inner.watchMessages(query, signal)) {
        if (!message.isFromMe) continue; // `sender: 'me'` is the only query there is
        if (!this.engine.chatVisible({ id: message.chatId, accountId: message.accountId })) continue;
        await this.audit.record({
          ts: this.now().toISOString(),
          action: name,
          decision: 'allowed',
          stage: 'delivery',
          opId,
          context: { chatId: message.chatId, messageId: message.id },
        });
        yield message;
      }
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      await this.audit
        .record({
          ts: this.now().toISOString(),
          action: name,
          decision: 'allowed',
          stage: 'outcome',
          opId,
          ...(failure === undefined
            ? { outcome: 'ok' as const }
            : { outcome: 'error' as const, error: errorCode(failure) }),
          context,
        })
        .catch(() => undefined);
    }
  }

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    // reserveSend consumes the rate slot at decision time, synchronously —
    // concurrent in-flight sends cannot all observe the pre-send count.
    return this.guardMutation(
      this.engine.reserveSend({ chatId: input.chatId, textLength: input.text.length }),
      'sendMessage',
      // Outbound text is intentionally recorded — see audit.ts content policy.
      { chatId: input.chatId, text: input.text, replyToMessageId: input.replyToMessageId },
      () => this.inner.sendMessage(input),
      (result) => ({ pendingMessageId: result.pendingMessageId }),
    );
  }

  markChatRead(chatId: string): Promise<void> {
    return this.guardMutation(this.engine.check({ kind: 'markRead', chatId }), 'markChatRead', { chatId }, () =>
      this.inner.markChatRead(chatId),
    );
  }
}
