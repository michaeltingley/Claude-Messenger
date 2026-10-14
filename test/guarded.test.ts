import { describe, expect, it } from 'vitest';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { PolicyDeniedError, ProviderError } from '../src/core/errors.js';
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

  it('keeps out chats, messages and accounts that come with no account ID while the allowlist names accounts', async () => {
    // A provider's types promise an account ID; its wire may still leave one out.
    const none = undefined as unknown as string;
    const fake = new FakeMessenger();
    fake.chats = [makeChat({ id: 'chat-1', accountId: 'signal-1' }), makeChat({ id: 'chat-none', accountId: none })];
    fake.messages = [
      makeMessage({ id: 'm1', chatId: 'chat-1', accountId: 'signal-1' }),
      makeMessage({ id: 'm-none', chatId: 'chat-none', accountId: none }),
    ];
    const audit = new MemoryAuditLogger();
    const policy = parsePolicy({ version: 1, read: { accountAllowlist: ['signal-1'] } });
    const guarded = new GuardedMessenger(fake, new PolicyEngine(policy), audit);

    expect((await guarded.searchChats()).items.map((c) => c.id)).toEqual(['chat-1']);
    expect((await guarded.searchMessages({ query: 'hello' })).items.map((m) => m.id)).toEqual(['m1']);
    expect((await guarded.listAccounts()).map((a) => a.id)).toEqual(['signal-1']);
    await expect(guarded.getChat('chat-none')).rejects.toMatchObject({ rule: 'read.accountAllowlist' });
    await expect(guarded.getMessage('chat-none', 'm-none')).rejects.toMatchObject({ rule: 'read.accountAllowlist' });
    await expect(guarded.listMessages('chat-none')).rejects.toMatchObject({ rule: 'read.accountAllowlist' });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'listMessages', decision: 'denied', rule: 'read.accountAllowlist' });

    // Allowing every account allows these too.
    const open = new GuardedMessenger(fake, new PolicyEngine(parsePolicy({ version: 1 })), new MemoryAuditLogger());
    expect((await open.searchMessages({ query: 'hello' })).items.map((m) => m.id)).toEqual(['m1', 'm-none']);
    expect((await open.getChat('chat-none')).id).toBe('chat-none');
    expect((await open.getMessage('chat-none', 'm-none')).id).toBe('m-none');
  });

  it('refuses direct access to a denylisted chat', async () => {
    const { guarded } = setup();
    await expect(guarded.getChat('chat-secret')).rejects.toThrow(PolicyDeniedError);
    await expect(guarded.listMessages('chat-secret')).rejects.toThrow(PolicyDeniedError);
    await expect(guarded.getMessage('chat-secret', 'm2')).rejects.toThrow(PolicyDeniedError);
  });

  it('applies the account allowlist to chats and accounts', async () => {
    const { guarded } = setup({ read: { accountAllowlist: ['signal-1'], chatDenylist: [] } });
    expect((await guarded.searchChats()).items.map((c) => c.id)).toEqual(['chat-signal']);
    expect((await guarded.listAccounts()).map((a) => a.id)).toEqual(['signal-1']);
    // A message's account is known only once it is fetched, and then it is kept back.
    await expect(guarded.getMessage('chat-1', 'm1')).rejects.toMatchObject({ rule: 'read.accountAllowlist' });
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

  it('audits provider failures as errors, by their code', async () => {
    const { guarded, audit } = setup();
    await expect(guarded.getChat('missing')).rejects.toThrow();
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'getChat',
      decision: 'allowed',
      outcome: 'error',
      error: 'not_found',
    });
  });

  it("records a failure by its code, never the provider's text, which can quote a message it read, while the caller gets the whole error", async () => {
    const { fake, audit, guarded } = setup({
      capabilities: { read: true, send: true, markRead: true },
      send: { chatAllowlist: '*' },
    });
    const quoting = new ProviderError('Beeper API error (500): cannot render "meet me behind the mill at 8"');
    const fail = async (): Promise<never> => {
      throw quoting;
    };
    Object.assign(fake, {
      checkConnection: fail,
      listAccounts: fail,
      searchChats: fail,
      getChat: fail,
      listMessages: fail,
      getMessage: fail,
      searchMessages: fail,
      sendMessage: fail,
      markChatRead: fail,
    });

    const calls: Array<[string, () => Promise<unknown>]> = [
      ['checkConnection', () => guarded.checkConnection()],
      ['listAccounts', () => guarded.listAccounts()],
      ['searchChats', () => guarded.searchChats()],
      ['getChat', () => guarded.getChat('chat-1')],
      ['listMessages', () => guarded.listMessages('chat-1')],
      ['getMessage', () => guarded.getMessage('chat-1', 'm1')],
      ['searchMessages', () => guarded.searchMessages({ query: 'hello' })],
      ['sendMessage', () => guarded.sendMessage({ chatId: 'chat-1', text: 'on my way' })],
      ['markChatRead', () => guarded.markChatRead('chat-1')],
    ];
    for (const [action, call] of calls) {
      await expect(call()).rejects.toBe(quoting);
      expect(audit.entries.at(-1)).toMatchObject({ action, decision: 'allowed', outcome: 'error', error: 'provider_error' });
    }
    expect(JSON.stringify(audit.entries)).not.toContain('behind the mill');
  });

  it('records any other failure as internal_error, without its text', async () => {
    const { fake, audit, guarded } = setup();
    // What V8 says of a body that isn't JSON quotes the start of the body.
    let notJson: unknown;
    try {
      JSON.parse('meet me behind the mill at 8');
    } catch (err) {
      notJson = err;
    }
    expect(String(notJson)).toContain('meet me');
    fake.searchMessages = async () => {
      throw notJson;
    };
    fake.listAccounts = async () => {
      // A provider may throw what isn't an Error at all.
      throw 'meet me behind the mill at 8';
    };

    await expect(guarded.searchMessages({ query: 'hello' })).rejects.toBe(notJson);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'searchMessages', outcome: 'error', error: 'internal_error' });
    await expect(guarded.listAccounts()).rejects.toBe('meet me behind the mill at 8');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'listAccounts', outcome: 'error', error: 'internal_error' });
    expect(JSON.stringify(audit.entries)).not.toContain('meet me');
  });
});
