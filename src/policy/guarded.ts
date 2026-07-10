import type { Messenger } from '../core/messenger.js';
import type {
  Account,
  Chat,
  ChatQuery,
  Message,
  MessageListQuery,
  MessageSearchQuery,
  Page,
  SendMessageInput,
  SendMessageResult,
  ServerInfo,
} from '../core/types.js';
import { PolicyDeniedError } from '../core/errors.js';
import type { AuditLogger } from './audit.js';
import type { PolicyAction, PolicyEngine } from './policy.js';

/**
 * The only Messenger the tool layer (MCP, CLI, automations) is ever handed.
 *
 * Every call is checked against the policy engine and written to the audit
 * log; read results are additionally filtered so denylisted chats and
 * non-allowlisted accounts never reach Claude's context at all.
 */
export class GuardedMessenger implements Messenger {
  constructor(
    private readonly inner: Messenger,
    private readonly engine: PolicyEngine,
    private readonly audit: AuditLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async guard<T>(
    action: PolicyAction,
    name: string,
    context: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    const decision = this.engine.check(action);
    const ts = this.now().toISOString();
    if (!decision.allowed) {
      await this.audit.record({ ts, action: name, decision: 'denied', rule: decision.rule, context });
      throw new PolicyDeniedError(decision.reason, decision.rule);
    }
    try {
      const result = await run();
      await this.audit.record({ ts, action: name, decision: 'allowed', outcome: 'ok', context });
      return result;
    } catch (err) {
      await this.audit.record({
        ts,
        action: name,
        decision: 'allowed',
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
        context,
      });
      throw err;
    }
  }

  whoami(): Promise<ServerInfo> {
    return this.guard({ kind: 'whoami' }, 'whoami', {}, () => this.inner.whoami());
  }

  listAccounts(): Promise<Account[]> {
    return this.guard({ kind: 'listAccounts' }, 'listAccounts', {}, async () => {
      const accounts = await this.inner.listAccounts();
      return accounts.filter((a) => this.engine.chatVisible({ id: '', accountId: a.id }));
    });
  }

  searchChats(query?: ChatQuery): Promise<Page<Chat>> {
    return this.guard({ kind: 'read' }, 'searchChats', { query: query?.query, type: query?.type }, async () => {
      const page = await this.inner.searchChats(query);
      return { ...page, items: page.items.filter((c) => this.engine.chatVisible(c)) };
    });
  }

  getChat(chatId: string): Promise<Chat> {
    return this.guard({ kind: 'read', chatId }, 'getChat', { chatId }, async () => {
      const chat = await this.inner.getChat(chatId);
      if (!this.engine.chatVisible(chat)) {
        throw new PolicyDeniedError(`Chat ${chatId} is not visible under the current policy.`, 'read');
      }
      return chat;
    });
  }

  listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    return this.guard({ kind: 'read', chatId }, 'listMessages', { chatId }, async () => {
      // Resolve the chat first so account-level read rules apply too.
      const chat = await this.inner.getChat(chatId);
      if (!this.engine.chatVisible(chat)) {
        throw new PolicyDeniedError(`Chat ${chatId} is not visible under the current policy.`, 'read');
      }
      return this.inner.listMessages(chatId, query);
    });
  }

  searchMessages(query: MessageSearchQuery): Promise<Page<Message>> {
    return this.guard(
      { kind: 'read' },
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

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.guard(
      { kind: 'send', chatId: input.chatId, textLength: input.text.length },
      'sendMessage',
      // Outbound text is intentionally recorded — see audit.ts content policy.
      { chatId: input.chatId, text: input.text, replyToMessageId: input.replyToMessageId },
      async () => {
        const result = await this.inner.sendMessage(input);
        this.engine.recordSend();
        return result;
      },
    );
  }

  markChatRead(chatId: string): Promise<void> {
    return this.guard({ kind: 'markRead', chatId }, 'markChatRead', { chatId }, () =>
      this.inner.markChatRead(chatId),
    );
  }
}
