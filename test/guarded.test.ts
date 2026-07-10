import { describe, expect, it } from 'vitest';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { PolicyDeniedError } from '../src/core/errors.js';
import { FakeMessenger, makeChat, makeMessage } from './fake-messenger.js';

function setup(policyOverrides: Record<string, unknown> = {}) {
  const fake = new FakeMessenger();
  fake.chats = [
    makeChat({ id: 'chat-1', accountId: 'whatsapp-1', title: 'Alice' }),
    makeChat({ id: 'chat-secret', accountId: 'whatsapp-1', title: 'Secret' }),
    makeChat({ id: 'chat-signal', accountId: 'signal-1', network: 'signal', title: 'Bob' }),
  ];
  fake.messages = [
    makeMessage({ id: 'm1', chatId: 'chat-1' }),
    makeMessage({ id: 'm2', chatId: 'chat-secret', text: 'hidden hello' }),
  ];
  const audit = new MemoryAuditLogger();
  const policy = parsePolicy({
    version: 1,
    read: { accountAllowlist: '*', chatDenylist: ['chat-secret'] },
    ...policyOverrides,
  });
  const guarded = new GuardedMessenger(fake, new PolicyEngine(policy), audit);
  return { fake, audit, guarded };
}

describe('GuardedMessenger', () => {
  it('filters denylisted chats out of search results', async () => {
    const { guarded } = setup();
    const page = await guarded.searchChats();
    expect(page.items.map((c) => c.id)).toEqual(['chat-1', 'chat-signal']);
  });

  it('filters denylisted chats out of message search results', async () => {
    const { guarded } = setup();
    const page = await guarded.searchMessages({ query: 'hello' });
    expect(page.items.map((m) => m.id)).toEqual(['m1']);
  });

  it('refuses direct access to a denylisted chat', async () => {
    const { guarded } = setup();
    await expect(guarded.getChat('chat-secret')).rejects.toThrow(PolicyDeniedError);
    await expect(guarded.listMessages('chat-secret')).rejects.toThrow(PolicyDeniedError);
  });

  it('applies the account allowlist to chats and accounts', async () => {
    const { guarded } = setup({ read: { accountAllowlist: ['signal-1'], chatDenylist: [] } });
    expect((await guarded.searchChats()).items.map((c) => c.id)).toEqual(['chat-signal']);
    expect((await guarded.listAccounts()).map((a) => a.id)).toEqual(['signal-1']);
  });

  it('blocks sends under the default read-only policy and never reaches the provider', async () => {
    const { guarded, fake, audit } = setup();
    await expect(guarded.sendMessage({ chatId: 'chat-1', text: 'hi' })).rejects.toThrow(PolicyDeniedError);
    expect(fake.sent).toHaveLength(0);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'sendMessage',
      decision: 'denied',
      rule: 'capabilities.send',
    });
  });

  it('allows allowlisted sends, records them, and audits the outbound text', async () => {
    const { guarded, fake, audit } = setup({
      capabilities: { read: true, send: true, markRead: false },
      send: { chatAllowlist: ['chat-1'], maxMessagesPerHour: 5, maxCharsPerMessage: 100 },
    });
    const result = await guarded.sendMessage({ chatId: 'chat-1', text: 'on my way' });
    expect(result.pendingMessageId).toBe('pending-1');
    expect(fake.sent).toEqual([{ chatId: 'chat-1', text: 'on my way' }]);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'sendMessage',
      decision: 'allowed',
      outcome: 'ok',
      context: { chatId: 'chat-1', text: 'on my way' },
    });
  });

  it('audits every read with the query but never with message content', async () => {
    const { guarded, audit } = setup();
    await guarded.searchMessages({ query: 'hello' });
    const entry = audit.entries.at(-1)!;
    expect(entry).toMatchObject({ action: 'searchMessages', decision: 'allowed', outcome: 'ok' });
    expect(JSON.stringify(entry.context)).not.toContain('hidden hello');
  });

  it('audits provider failures as errors', async () => {
    const { guarded, audit } = setup();
    await expect(guarded.getChat('missing')).rejects.toThrow();
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'getChat',
      decision: 'allowed',
      outcome: 'error',
    });
  });
});
