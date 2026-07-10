import { describe, expect, it } from 'vitest';
import { toAccount, toChat, toMessage, toPage } from '../src/providers/beeper/mapper.js';

/** Wire-shape edge cases the integration fixtures don't reach. */
describe('mapper', () => {
  it('flags truncated participant lists so Claude knows the roster is incomplete', () => {
    const chat = toChat({
      id: 'c1',
      accountID: 'a1',
      network: 'whatsapp',
      type: 'group',
      title: 'Big Group',
      unreadCount: 0,
      participants: { items: [{ id: 'p1' }], hasMore: true, total: 500 },
    } as never);
    expect(chat.participantsTruncated).toBe(true);

    const small = toChat({
      id: 'c2',
      accountID: 'a1',
      network: 'whatsapp',
      type: 'single',
      title: 'Solo',
      unreadCount: 0,
      participants: { items: [{ id: 'p1' }], hasMore: false, total: 1 },
    } as never);
    expect(small.participantsTruncated).toBeUndefined();
  });

  it('defaults isFromMe to false when the wire omits isSender', () => {
    const message = toMessage({
      id: 'm1',
      accountID: 'a1',
      chatID: 'c1',
      senderID: 's1',
      sortKey: '1',
      timestamp: '2026-01-01T00:00:00Z',
    } as never);
    expect(message.isFromMe).toBe(false);
    expect(message.attachments).toEqual([]);
    expect(message.reactions).toEqual([]);
  });

  it('maps reactions across the wire field renames', () => {
    const message = toMessage({
      id: 'm1',
      accountID: 'a1',
      chatID: 'c1',
      senderID: 's1',
      sortKey: '1',
      timestamp: '2026-01-01T00:00:00Z',
      reactions: [{ id: 'r1', participantID: 'alice', reactionKey: '👍' }],
      linkedMessageID: 'm0',
    } as never);
    expect(message.reactions).toEqual([{ key: '👍', participantId: 'alice' }]);
    expect(message.replyToMessageId).toBe('m0');
  });

  it('degrades gracefully when both network and bridge are absent (pre-4.2.785 Beeper Desktop)', () => {
    const account = toAccount({ accountID: 'a1', user: { id: 'me' } } as never);
    expect(account.network).toBe('unknown');
    const bridged = toAccount({
      accountID: 'a2',
      bridge: { id: 'b', provider: 'cloud', type: 'signal' },
      user: { id: 'me' },
    } as never);
    expect(bridged.network).toBe('signal');
  });

  it('toPage omits nextCursor at the end of a result set', () => {
    const done = toPage({ items: [1], hasMore: false, oldestCursor: null }, (n) => n);
    expect(done.nextCursor).toBeUndefined();
    const more = toPage({ items: [1], hasMore: true, oldestCursor: 'abc' }, (n) => n * 2);
    expect(more).toEqual({ items: [2], hasMore: true, nextCursor: 'abc' });
  });
});
