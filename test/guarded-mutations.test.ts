import { describe, expect, it } from 'vitest';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger, type AuditEntry, type AuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { PolicyDeniedError } from '../src/core/errors.js';
import { FakeMessenger, makeChat } from './fake-messenger.js';

/**
 * The mutation-side guarantees: intent-before-dispatch auditing, rate-limit
 * reservation under concurrency, and markRead's positive path.
 */

const sendAllPolicy = (maxPerHour = 10) =>
  parsePolicy({
    version: 1,
    capabilities: { read: true, send: true, markRead: true },
    read: { accountAllowlist: '*', chatDenylist: ['chat-secret'] },
    send: { chatAllowlist: '*', maxMessagesPerHour: maxPerHour, maxCharsPerMessage: 100 },
  });

function setup(maxPerHour = 10, audit: AuditLogger = new MemoryAuditLogger()) {
  const fake = new FakeMessenger();
  fake.chats = [makeChat({ id: 'chat-1' })];
  const guarded = new GuardedMessenger(fake, new PolicyEngine(sendAllPolicy(maxPerHour)), audit);
  return { fake, guarded, audit };
}

describe('GuardedMessenger mutations', () => {
  it('writes an intent entry before dispatch and an outcome entry after', async () => {
    const audit = new MemoryAuditLogger();
    const { guarded, fake } = setup(10, audit);
    await guarded.sendMessage({ chatId: 'chat-1', text: 'hi' });

    const stages = audit.entries.filter((e) => e.action === 'sendMessage').map((e) => e.stage);
    expect(stages).toEqual(['intent', 'outcome']);
    expect(audit.entries[0]).toMatchObject({ stage: 'intent', context: { chatId: 'chat-1', text: 'hi' } });
    expect(audit.entries[1]).toMatchObject({ stage: 'outcome', outcome: 'ok' });
    expect(fake.sent).toHaveLength(1);
  });

  it('does NOT dispatch when the intent audit write fails — no unaudited sends', async () => {
    const failingAudit: AuditLogger = {
      record: async () => {
        throw new Error('disk full');
      },
    };
    const { guarded, fake } = setup(10, failingAudit);
    await expect(guarded.sendMessage({ chatId: 'chat-1', text: 'hi' })).rejects.toThrow('disk full');
    expect(fake.sent).toHaveLength(0);
  });

  it('a failing OUTCOME write does not turn a delivered send into an error (no duplicate-send bait)', async () => {
    let calls = 0;
    const entries: AuditEntry[] = [];
    const flakyAudit: AuditLogger = {
      record: async (entry) => {
        calls += 1;
        if (calls > 1) throw new Error('disk full after dispatch');
        entries.push(entry);
      },
    };
    const { guarded, fake } = setup(10, flakyAudit);
    const result = await guarded.sendMessage({ chatId: 'chat-1', text: 'hi' });
    expect(result.pendingMessageId).toBe('pending-1');
    expect(fake.sent).toHaveLength(1); // sent exactly once, reported as success
    expect(entries[0]).toMatchObject({ stage: 'intent' });
  });

  it('enforces the rate limit under concurrency: N parallel sends cannot all pass the gate', async () => {
    const { guarded, fake } = setup(2);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => guarded.sendMessage({ chatId: 'chat-1', text: `msg ${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(fake.sent).toHaveLength(2);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PolicyDeniedError);
      expect(((r as PromiseRejectedResult).reason as PolicyDeniedError).rule).toBe('send.maxMessagesPerHour');
    }
  });

  it('a failed dispatch still consumes its rate slot (limiter fails closed)', async () => {
    const audit = new MemoryAuditLogger();
    const { guarded, fake } = setup(1, audit);
    fake.sendMessage = async () => {
      throw new Error('network blip');
    };
    await expect(guarded.sendMessage({ chatId: 'chat-1', text: 'hi' })).rejects.toThrow('network blip');
    await expect(guarded.sendMessage({ chatId: 'chat-1', text: 'hi' })).rejects.toMatchObject({
      rule: 'send.maxMessagesPerHour',
    });
  });

  it('markChatRead positive path: reaches the provider and is audited intent → outcome', async () => {
    const audit = new MemoryAuditLogger();
    const { guarded, fake } = setup(10, audit);
    await guarded.markChatRead('chat-1');
    expect(fake.markedRead).toEqual(['chat-1']);
    expect(audit.entries.map((e) => e.stage)).toEqual(['intent', 'outcome']);
  });

  it('markChatRead on a denylisted chat is denied even with the capability enabled', async () => {
    const { guarded, fake } = setup();
    await expect(guarded.markChatRead('chat-secret')).rejects.toMatchObject({ rule: 'read.chatDenylist' });
    expect(fake.markedRead).toHaveLength(0);
  });

  it('listMessages on an account-hidden chat denies with the true rule instead of a silent empty page', async () => {
    const fake = new FakeMessenger();
    fake.chats = [makeChat({ id: 'chat-1', accountId: 'hidden-acct' })];
    fake.messages = [
      { ...(await import('./fake-messenger.js')).makeMessage({ chatId: 'chat-1', accountId: 'hidden-acct' }) },
    ];
    const audit = new MemoryAuditLogger();
    const guarded = new GuardedMessenger(
      fake,
      new PolicyEngine(
        parsePolicy({ version: 1, read: { accountAllowlist: ['other-acct'], chatDenylist: [] } }),
      ),
      audit,
    );
    await expect(guarded.listMessages('chat-1')).rejects.toMatchObject({ rule: 'read.accountAllowlist' });
    expect(audit.entries.at(-1)).toMatchObject({ decision: 'denied', rule: 'read.accountAllowlist' });
  });
});
