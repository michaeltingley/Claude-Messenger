import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy, PolicyEngine } from '../src/policy/policy.js';

const sendPolicy = (overrides: Record<string, unknown> = {}) =>
  parsePolicy({
    version: 1,
    capabilities: { read: true, send: true, markRead: false },
    send: { chatAllowlist: ['chat-ok'], maxMessagesPerHour: 2, maxCharsPerMessage: 10 },
    ...overrides,
  });

describe('PolicyEngine', () => {
  it('default policy is read-only', () => {
    const engine = new PolicyEngine(DEFAULT_POLICY);
    expect(engine.check({ kind: 'read' }).allowed).toBe(true);
    expect(engine.reserveSend({ chatId: 'any', textLength: 1 })).toMatchObject({
      allowed: false,
      rule: 'capabilities.send',
    });
    expect(engine.check({ kind: 'markRead', chatId: 'any' })).toMatchObject({
      allowed: false,
      rule: 'capabilities.markRead',
    });
  });

  it('sends require the chat to be allowlisted', () => {
    const engine = new PolicyEngine(sendPolicy());
    expect(engine.reserveSend({ chatId: 'chat-ok', textLength: 5 }).allowed).toBe(true);
    expect(engine.reserveSend({ chatId: 'chat-other', textLength: 5 })).toMatchObject({
      allowed: false,
      rule: 'send.chatAllowlist',
    });
  });

  it('enforces message length limits', () => {
    const engine = new PolicyEngine(sendPolicy());
    expect(engine.reserveSend({ chatId: 'chat-ok', textLength: 11 })).toMatchObject({
      allowed: false,
      rule: 'send.maxCharsPerMessage',
    });
  });

  it('rate limits sends per hour with a sliding window, reserving at decision time', () => {
    let now = 0;
    const engine = new PolicyEngine(sendPolicy(), () => now);
    const send = { chatId: 'chat-ok', textLength: 1 };

    expect(engine.reserveSend(send).allowed).toBe(true);
    expect(engine.reserveSend(send).allowed).toBe(true);
    expect(engine.reserveSend(send)).toMatchObject({ allowed: false, rule: 'send.maxMessagesPerHour' });

    now = 3_600_001; // window slides
    expect(engine.reserveSend(send).allowed).toBe(true);
  });

  it('allows a message exactly at maxCharsPerMessage and denies one char over', () => {
    const engine = new PolicyEngine(sendPolicy());
    expect(engine.reserveSend({ chatId: 'chat-ok', textLength: 10 }).allowed).toBe(true);
    expect(engine.reserveSend({ chatId: 'chat-ok', textLength: 11 })).toMatchObject({
      allowed: false,
      rule: 'send.maxCharsPerMessage',
    });
  });

  it("chatAllowlist '*' permits sending to any non-denylisted chat", () => {
    const engine = new PolicyEngine(
      sendPolicy({
        send: { chatAllowlist: '*', maxMessagesPerHour: 10, maxCharsPerMessage: 100 },
      }),
    );
    expect(engine.reserveSend({ chatId: 'never-seen-before', textLength: 1 }).allowed).toBe(true);
  });

  it('denylisted chats are blocked for read, send, and markRead', () => {
    const engine = new PolicyEngine(
      sendPolicy({
        capabilities: { read: true, send: true, markRead: true },
        read: { accountAllowlist: '*', chatDenylist: ['secret'] },
        send: { chatAllowlist: '*', maxMessagesPerHour: 10, maxCharsPerMessage: 100 },
      }),
    );
    expect(engine.check({ kind: 'read', chatId: 'secret' }).allowed).toBe(false);
    expect(engine.reserveSend({ chatId: 'secret', textLength: 1 }).allowed).toBe(false);
    expect(engine.check({ kind: 'markRead', chatId: 'secret' }).allowed).toBe(false);
    expect(engine.chatVisible({ id: 'secret', accountId: 'whatsapp-1' })).toBe(false);
  });

  it('admits nothing that comes with no account ID past an account allowlist that names accounts', () => {
    const engine = new PolicyEngine(
      parsePolicy({ version: 1, read: { accountAllowlist: ['signal-1'], chatDenylist: ['secret'] } }),
    );
    // A request may name only the chat: the guard checks the account once the chat is fetched.
    expect(engine.check({ kind: 'read', chatId: 'c' }).allowed).toBe(true);
    for (const accountId of [undefined, '']) {
      expect(engine.chatVisible({ id: 'c', accountId })).toBe(false);
      expect(engine.accountVisible(accountId)).toBe(false);
      expect(engine.checkVisible({ chatId: 'c', accountId })).toMatchObject({
        allowed: false,
        rule: 'read.accountAllowlist',
        reason: expect.stringContaining('Chat c came with no account ID'),
      });
    }
    // The rules a read of any chat answers to come first.
    expect(engine.checkVisible({ chatId: 'secret', accountId: undefined })).toMatchObject({ rule: 'read.chatDenylist' });
    const off = new PolicyEngine(parsePolicy({ version: 1, capabilities: { read: false }, read: { accountAllowlist: ['signal-1'] } }));
    expect(off.checkVisible({ chatId: 'c', accountId: undefined })).toMatchObject({ rule: 'capabilities.read' });
  });

  it("an account allowlist of '*' admits what comes with no account ID, as it admits every account", () => {
    const engine = new PolicyEngine(parsePolicy({ version: 1, read: { accountAllowlist: '*', chatDenylist: ['secret'] } }));
    expect(engine.chatVisible({ id: 'c', accountId: undefined })).toBe(true);
    expect(engine.accountVisible(undefined)).toBe(true);
    expect(engine.chatVisible({ id: 'secret', accountId: undefined })).toBe(false);
  });

  describe('starting a direct chat', () => {
    const startChatPolicy = (overrides: Record<string, unknown> = {}) =>
      parsePolicy({
        version: 1,
        capabilities: { read: true, startChat: true },
        read: { accountAllowlist: ['matrix'], chatDenylist: [] },
        startChat: { userAllowlist: ['@owner:beeper.com'] },
        ...overrides,
      });

    it('is denied by default, naming the capability, whoever it is with', () => {
      expect(new PolicyEngine(DEFAULT_POLICY).check({ kind: 'startChat', accountId: 'matrix', userId: '@owner:beeper.com' })).toMatchObject({
        allowed: false,
        rule: 'capabilities.startChat',
      });
      // Allowlisting someone grants nothing while the capability is off.
      const off = new PolicyEngine(startChatPolicy({ capabilities: { read: true, startChat: false } }));
      expect(off.check({ kind: 'startChat', accountId: 'matrix', userId: '@owner:beeper.com' })).toMatchObject({
        rule: 'capabilities.startChat',
      });
    });

    it('is allowed only with someone the allowlist names', () => {
      const engine = new PolicyEngine(startChatPolicy());
      expect(engine.check({ kind: 'startChat', accountId: 'matrix', userId: '@owner:beeper.com' }).allowed).toBe(true);
      expect(engine.check({ kind: 'startChat', accountId: 'matrix', userId: '@stranger:beeper.com' })).toMatchObject({
        allowed: false,
        rule: 'startChat.userAllowlist',
        reason: expect.stringContaining('@stranger:beeper.com'),
      });
    });

    it('is denied on an account Claude may not read, since the chat comes back to it', () => {
      const engine = new PolicyEngine(startChatPolicy());
      expect(engine.check({ kind: 'startChat', accountId: 'whatsapp-1', userId: '@owner:beeper.com' })).toMatchObject({
        rule: 'read.accountAllowlist',
      });
      const blind = new PolicyEngine(startChatPolicy({ capabilities: { read: false, startChat: true } }));
      expect(blind.check({ kind: 'startChat', accountId: 'matrix', userId: '@owner:beeper.com' })).toMatchObject({
        rule: 'capabilities.read',
      });
    });

    it("can't be opened to everyone: the allowlist names each person", () => {
      expect(() => startChatPolicy({ startChat: { userAllowlist: '*' } })).toThrow();
    });
  });

  it('account allowlist restricts read visibility', () => {
    const engine = new PolicyEngine(
      parsePolicy({ version: 1, read: { accountAllowlist: ['signal-1'], chatDenylist: [] } }),
    );
    expect(engine.chatVisible({ id: 'c', accountId: 'signal-1' })).toBe(true);
    expect(engine.chatVisible({ id: 'c', accountId: 'whatsapp-1' })).toBe(false);
    expect(engine.check({ kind: 'read', accountId: 'whatsapp-1' })).toMatchObject({
      allowed: false,
      rule: 'read.accountAllowlist',
    });
  });
});
