import { describe, expect, it } from 'vitest';
import type { Message } from '../src/core/types.js';
import { PolicyDeniedError, ProviderError } from '../src/core/errors.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger, type AuditEntry, type AuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { FakeMessenger, makeMessage } from './fake-messenger.js';

const SINCE = '2026-10-13T00:00:00.000Z';
const QUERY = { sender: 'me', since: SINCE } as const;

/** One of the user's own messages, an hour after SINCE plus `minute`. */
const mine = (id: string, chatId: string, accountId: string, minute: number): Message =>
  makeMessage({
    id,
    chatId,
    accountId,
    isFromMe: true,
    timestamp: `2026-10-13T01:${String(minute).padStart(2, '0')}:00.000Z`,
    text: `private words in ${id}`,
  });

/** An audit sink that refuses the entries `refuse` picks, as a full disk would. */
class FailingAudit implements AuditLogger {
  readonly entries: AuditEntry[] = [];
  constructor(private readonly refuse: (entry: AuditEntry) => boolean) {}
  async record(entry: AuditEntry): Promise<void> {
    if (this.refuse(entry)) throw new Error('audit sink unavailable');
    this.entries.push(entry);
  }
}

function setup(options: { policy?: Record<string, unknown>; audit?: AuditLogger } = {}) {
  const fake = new FakeMessenger();
  fake.messages = [
    mine('m1', 'chat-1', 'whatsapp-1', 1),
    mine('in-secret', 'chat-secret', 'whatsapp-1', 2),
    mine('on-signal', 'chat-signal', 'signal-1', 3),
    mine('m2', 'chat-1', 'whatsapp-1', 4),
  ];
  const audit = options.audit ?? new MemoryAuditLogger();
  const policy = parsePolicy({
    version: 1,
    read: { accountAllowlist: ['whatsapp-1'], chatDenylist: ['chat-secret'] },
    ...options.policy,
  });
  const guarded = new GuardedMessenger(fake, new PolicyEngine(policy), audit);
  return { fake, audit, guarded };
}

/** Reads the watch in the background until it ends, recording what it delivers and how it ends. */
function follow(guarded: GuardedMessenger) {
  const stop = new AbortController();
  const got: string[] = [];
  const state: { error?: unknown } = {};
  const finished = (async () => {
    try {
      for await (const m of guarded.watchMessages(QUERY, stop.signal)) got.push(m.id);
    } catch (err) {
      state.error = err;
    }
  })();
  return { stop, got, state, finished };
}

/** Lets everything already arrived reach the reader. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('GuardedMessenger.watchMessages', () => {
  it('delivers only messages from chats the policy shows, as they arrive', async () => {
    const { fake, guarded } = setup();
    const watch = follow(guarded);
    await settle();
    expect(watch.got).toEqual(['m1', 'm2']);

    fake.arrive(mine('hidden-live', 'chat-secret', 'whatsapp-1', 5));
    fake.arrive(mine('m3', 'chat-1', 'whatsapp-1', 6));
    await settle();
    expect(watch.got).toEqual(['m1', 'm2', 'm3']);
    expect(fake.watchQueries).toEqual([QUERY]);

    watch.stop.abort();
    await watch.finished;
    expect(watch.state.error).toBeUndefined();
    expect(fake.openWatches).toBe(0);
  });

  it('audits the watch under one opId: intent, then each delivered message by ID only, then the outcome', async () => {
    const { audit, guarded } = setup();
    const watch = follow(guarded);
    await settle();
    watch.stop.abort();
    await watch.finished;

    const entries = (audit as MemoryAuditLogger).entries;
    expect(entries.map((e) => [e.stage, e.context])).toEqual([
      ['intent', { sender: 'me', since: SINCE }],
      ['delivery', { chatId: 'chat-1', messageId: 'm1' }],
      ['delivery', { chatId: 'chat-1', messageId: 'm2' }],
      ['outcome', { sender: 'me', since: SINCE }],
    ]);
    expect(entries.every((e) => e.action === 'watchMessages' && e.decision === 'allowed')).toBe(true);
    expect(new Set(entries.map((e) => e.opId)).size).toBe(1);
    expect(entries.at(-1)).toMatchObject({ outcome: 'ok' });
    // What was read is never written down: not the text, and nothing from hidden chats.
    expect(JSON.stringify(entries)).not.toContain('private words');
    expect(JSON.stringify(entries)).not.toContain('in-secret');
  });

  it('is denied when reading is off, naming the rule in the error and the audit, and never opens a watch', async () => {
    const { audit, fake, guarded } = setup({ policy: { capabilities: { read: false } } });
    const watch = follow(guarded);
    await settle();
    expect(watch.state.error).toBeInstanceOf(PolicyDeniedError);
    expect((watch.state.error as PolicyDeniedError).rule).toBe('capabilities.read');
    expect((audit as MemoryAuditLogger).entries).toEqual([
      expect.objectContaining({ action: 'watchMessages', decision: 'denied', rule: 'capabilities.read' }),
    ]);
    expect(fake.watchQueries).toEqual([]);
  });

  it('opens no watch when its intent cannot be audited', async () => {
    const { fake, guarded } = setup({ audit: new FailingAudit(() => true) });
    const watch = follow(guarded);
    await settle();
    expect(String(watch.state.error)).toContain('audit sink unavailable');
    expect(fake.watchQueries).toEqual([]);
  });

  it('never hands on a message whose delivery cannot be audited: the watch ends, and so does the backend one', async () => {
    const audit = new FailingAudit((e) => e.stage === 'delivery');
    const { fake, guarded } = setup({ audit });
    const watch = follow(guarded);
    await settle();
    expect(watch.got).toEqual([]);
    expect(String(watch.state.error)).toContain('audit sink unavailable');
    expect(fake.openWatches).toBe(0);
    expect(audit.entries.at(-1)).toMatchObject({ stage: 'outcome', outcome: 'error', error: 'audit sink unavailable' });
  });

  it('ends with the backend failure, recording it as the outcome', async () => {
    const { audit, fake, guarded } = setup();
    const watch = follow(guarded);
    await settle();
    fake.fail(new ProviderError('Beeper API error (500): boom'));
    await settle();
    expect(watch.got).toEqual(['m1', 'm2']);
    expect(watch.state.error).toBeInstanceOf(ProviderError);
    expect((audit as MemoryAuditLogger).entries.at(-1)).toMatchObject({
      stage: 'outcome',
      outcome: 'error',
      error: 'Beeper API error (500): boom',
    });
  });

  it('closes the backend watch, with a clean outcome, when the reader stops early', async () => {
    const { audit, fake, guarded } = setup();
    for await (const m of guarded.watchMessages(QUERY, new AbortController().signal)) {
      expect(m.id).toBe('m1');
      break;
    }
    expect(fake.openWatches).toBe(0);
    expect((audit as MemoryAuditLogger).entries.at(-1)).toMatchObject({ stage: 'outcome', outcome: 'ok' });
  });
});
