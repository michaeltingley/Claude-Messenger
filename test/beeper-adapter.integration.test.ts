import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { AuthError, ConnectionError, NotFoundError, ProviderError } from '../src/core/errors.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

/**
 * Integration: BeeperMessenger over real HTTP against a wire-faithful mock
 * of the Beeper Client API — request shapes, response mapping, and error
 * translation, exactly as they'd flow against Beeper Desktop/Server.
 */
describe('BeeperMessenger (HTTP integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let messenger: BeeperMessenger;

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    messenger = new BeeperMessenger({ accessToken: mock.token, baseUrl, maxRetries: 0 });
    mock.chats = [
      wireChat(),
      wireChat({ id: '!chat2:beeper.com', accountID: 'signal-1', network: 'signal', title: 'Bob', type: 'group' }),
    ];
    mock.messages = [
      wireMessage(),
      wireMessage({ id: 'msg-2', text: 'totally different', isSender: true, senderID: 'me' }),
    ];
  });

  afterEach(async () => {
    await mock.stop();
  });

  it('whoami maps server info', async () => {
    const info = await messenger.whoami();
    expect(info).toMatchObject({ appName: 'MockBeeper', appVersion: '9.9.9', remoteAccess: false });
  });

  it('listAccounts maps accounts with their user', async () => {
    const accounts = await messenger.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      id: 'whatsapp-1',
      network: 'whatsapp',
      user: { id: 'me', fullName: 'Test User', isSelf: true },
    });
  });

  it('searchChats sends query params and maps chats + cursor', async () => {
    const page = await messenger.searchChats({ query: 'ali', limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: '!chat1:beeper.com',
      accountId: 'whatsapp-1',
      network: 'whatsapp',
      title: 'Alice',
      unreadCount: 2,
      participants: [{ id: 'alice', fullName: 'Alice' }],
    });
    expect(page.nextCursor).toBe('cursor-oldest');

    const req = mock.requests.find((r) => r.path === '/v1/chats/search')!;
    expect(req.query.get('query')).toBe('ali');
    expect(req.query.get('limit')).toBe('5');
  });

  it('getChat fetches by ID including IDs that need URL encoding', async () => {
    const chat = await messenger.getChat('!chat2:beeper.com');
    expect(chat.title).toBe('Bob');
    expect(chat.type).toBe('group');
  });

  it('listMessages maps messages including reply/attachment fields', async () => {
    mock.messages = [
      wireMessage({
        attachments: [{ type: 'img', fileName: 'photo.jpg' }],
      }),
    ];
    const page = await messenger.listMessages('!chat1:beeper.com');
    expect(page.items[0]).toMatchObject({
      id: 'msg-1',
      chatId: '!chat1:beeper.com',
      senderName: 'Alice',
      isFromMe: false,
      text: 'hello from alice',
      attachments: [{ type: 'img', fileName: 'photo.jpg' }],
    });
  });

  it('searchMessages filters by word query over the wire', async () => {
    const page = await messenger.searchMessages({ query: 'different' });
    expect(page.items.map((m) => m.id)).toEqual(['msg-2']);
    expect(page.items[0]!.isFromMe).toBe(true);
  });

  it('sendMessage POSTs text and returns the pending ID', async () => {
    const result = await messenger.sendMessage({
      chatId: '!chat1:beeper.com',
      text: 'hi there',
      replyToMessageId: 'msg-1',
    });
    expect(result.chatId).toBe('!chat1:beeper.com');
    expect(result.pendingMessageId).toMatch(/^pending-/);

    const req = mock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'))!;
    expect(req.body).toEqual({ text: 'hi there', replyToMessageID: 'msg-1' });
  });

  it('markChatRead POSTs to the read endpoint', async () => {
    await messenger.markChatRead('!chat1:beeper.com');
    expect(mock.requests.some((r) => r.method === 'POST' && r.path.endsWith('/read'))).toBe(true);
  });

  describe('error translation', () => {
    it('401 → AuthError with re-creation guidance', async () => {
      const wrongToken = new BeeperMessenger({ accessToken: 'wrong-token', baseUrl, maxRetries: 0 });
      await expect(wrongToken.listAccounts()).rejects.toThrow(AuthError);
      await expect(wrongToken.listAccounts()).rejects.toThrow(/Approved connections/);
    });

    it('404 → NotFoundError', async () => {
      await expect(messenger.getChat('!nope:beeper.com')).rejects.toThrow(NotFoundError);
    });

    it('5xx → ProviderError carrying status', async () => {
      mock.forcedError = { status: 500 };
      await expect(messenger.whoami()).rejects.toThrow(ProviderError);
    });

    it('unreachable endpoint → ConnectionError with actionable message', async () => {
      const dead = new BeeperMessenger({
        accessToken: 'x',
        baseUrl: 'http://127.0.0.1:1',
        maxRetries: 0,
      });
      await expect(dead.whoami()).rejects.toThrow(ConnectionError);
      await expect(dead.whoami()).rejects.toThrow(/Beeper Desktop \(or your Beeper Server\)/);
    });
  });
});
