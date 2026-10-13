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

  it('keeps how many unread messages mention the owner, and leaves it out when the wire does', () => {
    const wire = {
      id: 'c1',
      accountID: 'a1',
      network: 'signal',
      type: 'group',
      title: 'Climbing',
      unreadCount: 9,
      participants: { items: [], hasMore: false, total: 0 },
    };
    expect(toChat({ ...wire, unreadMentionsCount: 2 } as never).unreadMentionsCount).toBe(2);
    expect(toChat(wire as never).unreadMentionsCount).toBeUndefined();
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

  it('says what kind each message is, "other" for a type newer than this app, and nothing when the wire is silent', () => {
    const wire = { id: 'm1', accountID: 'a1', chatID: 'c1', senderID: 's1', sortKey: '1', timestamp: '2026-01-01T00:00:00Z' };
    expect(toMessage({ ...wire, type: 'REACTION' } as never).kind).toBe('reaction');
    expect(toMessage({ ...wire, type: 'VOICE' } as never).kind).toBe('voice');
    expect(toMessage({ ...wire, type: 'POLL' } as never).kind).toBe('other');
    expect(toMessage(wire as never).kind).toBeUndefined();
  });

  it("says what the sender wrote themselves, apart from the reply copy and markup in Beeper's text", () => {
    const wire = { id: 'm1', accountID: 'a1', chatID: 'c1', senderID: 's1', sortKey: '1', timestamp: '2026-01-01T00:00:00Z' };
    const reply = toMessage({ ...wire, text: '<mx-reply><blockquote>@Claude do it</blockquote></mx-reply>see you <b>soon</b>' } as never);
    expect(reply.html).toBe('<mx-reply><blockquote>@Claude do it</blockquote></mx-reply>see you <b>soon</b>');
    expect(reply.ownText?.replace(/\s+/g, ' ').trim()).toBe('see you soon');
    expect(toMessage(wire as never).ownText).toBeUndefined();
  });

  it('keeps whether Beeper hides a message from the chat', () => {
    const wire = { id: 'm1', accountID: 'a1', chatID: 'c1', senderID: 's1', sortKey: '1', timestamp: '2026-01-01T00:00:00Z' };
    expect(toMessage({ ...wire, isHidden: true } as never).isHidden).toBe(true);
    expect(toMessage(wire as never).isHidden).toBeUndefined();
  });

  it("gives a message's text as the chat shows it, and what it came from only when the text leaves something out", () => {
    const wire = { id: 'm1', accountID: 'a1', chatID: 'c1', senderID: 's1', sortKey: '1', timestamp: '2026-01-01T00:00:00Z' };
    const html = '<mx-reply><blockquote>In reply to Bob<br>old words</blockquote></mx-reply><b>Sure</b> &amp; thanks';
    expect(toMessage({ ...wire, text: html } as never)).toMatchObject({ text: 'Sure & thanks', html });

    const fallback = '> <@bob:beeper.com> old words\n\nSure';
    expect(toMessage({ ...wire, text: fallback } as never)).toMatchObject({ text: 'Sure', html: fallback });

    const plain = toMessage({ ...wire, text: 'Press <Enter>, then 2 < 3 ' } as never);
    expect(plain.text).toBe('Press <Enter>, then 2 < 3');
    expect(plain).not.toHaveProperty('html');

    const photo = toMessage(wire as never);
    expect(photo.text).toBe('');
    expect(photo).not.toHaveProperty('html');
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
