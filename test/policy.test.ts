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
    expect(engine.check({ kind: 'send', chatId: 'any', textLength: 1 })).toMatchObject({
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
    expect(engine.check({ kind: 'send', chatId: 'chat-ok', textLength: 5 }).allowed).toBe(true);
    expect(engine.check({ kind: 'send', chatId: 'chat-other', textLength: 5 })).toMatchObject({
      allowed: false,
      rule: 'send.chatAllowlist',
    });
  });

  it('enforces message length limits', () => {
    const engine = new PolicyEngine(sendPolicy());
    expect(engine.check({ kind: 'send', chatId: 'chat-ok', textLength: 11 })).toMatchObject({
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
    expect(engine.check({ kind: 'send', chatId: 'chat-ok', textLength: 10 }).allowed).toBe(true);
    expect(engine.check({ kind: 'send', chatId: 'chat-ok', textLength: 11 })).toMatchObject({
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
    expect(engine.check({ kind: 'send', chatId: 'never-seen-before', textLength: 1 }).allowed).toBe(true);
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
    expect(engine.check({ kind: 'send', chatId: 'secret', textLength: 1 }).allowed).toBe(false);
    expect(engine.check({ kind: 'markRead', chatId: 'secret' }).allowed).toBe(false);
    expect(engine.chatVisible({ id: 'secret', accountId: 'whatsapp-1' })).toBe(false);
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
