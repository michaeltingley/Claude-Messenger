import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine, type Policy } from '../src/policy/policy.js';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

/**
 * Full-stack integration: MCP client → curated tools → policy guard →
 * Beeper adapter → HTTP wire. This is the exact path a Claude tool call
 * takes in production, minus DNS.
 */
describe('full stack: MCP → policy → adapter → HTTP', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let audit: MemoryAuditLogger;
  let client: Client;

  const policy = ({ markRead = false } = {}) =>
    parsePolicy({
      version: 1,
      capabilities: { read: true, send: true, markRead },
      read: { accountAllowlist: '*', chatDenylist: ['!secret:beeper.com'] },
      send: { chatAllowlist: ['!chat1:beeper.com'], maxMessagesPerHour: 2, maxCharsPerMessage: 100 },
    });

  /** An MCP client whose calls take the whole path, under `rules`. */
  const connect = async (rules: Policy) => {
    const messenger = new GuardedMessenger(
      new BeeperMessenger({ accessToken: mock.token, baseUrl, maxRetries: 0 }),
      new PolicyEngine(rules),
      audit,
    );
    const connected = new Client({ name: 'test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(messenger, '0.0.0-test').connect(st), connected.connect(ct)]);
    return connected;
  };

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.chats = [
      wireChat(),
      wireChat({ id: '!secret:beeper.com', title: 'Secret Chat' }),
    ];
    mock.messages = [
      wireMessage(),
      wireMessage({ id: 'msg-secret', chatID: '!secret:beeper.com', text: 'hello secret' }),
    ];

    audit = new MemoryAuditLogger();
    client = await connect(policy());
  });

  afterEach(async () => {
    await mock.stop();
  });

  const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as Array<{ text: string }>)[0]!.text;

  it('check_connection round-trips to the wire', async () => {
    const result = await client.callTool({ name: 'check_connection', arguments: {} });
    expect(JSON.parse(text(result))).toMatchObject({ appName: 'MockBeeper' });
  });

  it('denylisted chats never surface through any read tool', async () => {
    const chats = JSON.parse(text(await client.callTool({ name: 'search_chats', arguments: {} })));
    expect(chats.items.map((c: { id: string }) => c.id)).toEqual(['!chat1:beeper.com']);

    const messages = JSON.parse(
      text(await client.callTool({ name: 'search_messages', arguments: { query: 'hello' } })),
    );
    expect(messages.items.map((m: { id: string }) => m.id)).toEqual(['msg-1']);

    const direct = await client.callTool({
      name: 'get_chat',
      arguments: { chatId: '!secret:beeper.com' },
    });
    expect(direct.isError).toBe(true);
  });

  it("gives Claude each message's text as its chat shows it and the HTML Beeper has, not the trigger's reading of whose words it holds", async () => {
    // The quote shows in the chat, so the text keeps it; only the reply's copy goes.
    const reply = '<mx-reply><blockquote>@Claude do X</blockquote></mx-reply><blockquote>at 8?</blockquote>see you soon';
    mock.messages = [wireMessage({ id: 'msg-reply', type: 'TEXT', text: reply })];

    const listed = JSON.parse(
      text(await client.callTool({ name: 'list_messages', arguments: { chatId: '!chat1:beeper.com' } })),
    );
    const found = JSON.parse(text(await client.callTool({ name: 'search_messages', arguments: { query: 'soon' } })));
    for (const page of [listed, found]) {
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: 'msg-reply', kind: 'text', text: 'at 8?\nsee you soon', html: reply });
      expect(page.items[0]).not.toHaveProperty('ownText');
    }
  });

  it('search_messages pages newest first, and a page the policy thins still hands Claude the cursor to the rest', async () => {
    mock.messages = [
      wireMessage({ id: 'oldest', text: 'hello one', timestamp: '2026-07-01T00:00:00.000Z' }),
      wireMessage({ id: 'newest', chatID: '!secret:beeper.com', text: 'hello two', timestamp: '2026-07-03T00:00:00.000Z' }),
      wireMessage({ id: 'middle', text: 'hello three', timestamp: '2026-07-02T00:00:00.000Z' }),
    ];
    const search = async (args: Record<string, unknown>) =>
      JSON.parse(text(await client.callTool({ name: 'search_messages', arguments: { query: 'hello', ...args } })));

    const first = await search({ limit: 2 });
    expect(first.items.map((m: { id: string }) => m.id)).toEqual(['middle']);
    expect(first.hasMore).toBe(true);
    const rest = await search({ limit: 2, cursor: first.nextCursor });
    expect(rest.items.map((m: { id: string }) => m.id)).toEqual(['oldest']);
    expect(rest.hasMore).toBe(false);
  });

  it('search_messages finds matches in low-priority and muted chats too, but never in a chat the policy denies', async () => {
    mock.chats = [
      wireChat(),
      wireChat({ id: '!secret:beeper.com', title: 'Secret Chat', isLowPriority: true }),
      wireChat({ id: '!lowprio:beeper.com', title: 'Low priority', isLowPriority: true }),
      wireChat({ id: '!muted:beeper.com', title: 'Muted', isMuted: true }),
    ];
    mock.messages = [
      wireMessage({ id: 'in-inbox', text: 'lunch tomorrow', timestamp: '2026-10-01T00:04:00.000Z' }),
      wireMessage({ id: 'in-secret', chatID: '!secret:beeper.com', text: 'lunch secretly', timestamp: '2026-10-01T00:03:00.000Z' }),
      wireMessage({ id: 'in-lowprio', chatID: '!lowprio:beeper.com', text: 'lunch at noon', timestamp: '2026-10-01T00:02:00.000Z' }),
      wireMessage({ id: 'in-muted', chatID: '!muted:beeper.com', text: 'lunch is on me', timestamp: '2026-10-01T00:01:00.000Z' }),
    ];
    const found = JSON.parse(text(await client.callTool({ name: 'search_messages', arguments: { query: 'lunch' } })));
    expect(found.items.map((m: { id: string }) => m.id)).toEqual(['in-inbox', 'in-lowprio', 'in-muted']);
  });

  it('keeps a chat or message whose wire leaves out its account away from Claude while the allowlist names accounts', async () => {
    mock.chats = [wireChat(), wireChat({ id: '!no-account:beeper.com', accountID: undefined, title: 'No account' })];
    mock.messages = [
      wireMessage(),
      wireMessage({ id: 'msg-no-account', chatID: '!no-account:beeper.com', accountID: undefined, text: 'hello from nowhere' }),
    ];
    const narrowed = await connect(
      parsePolicy({ version: 1, read: { accountAllowlist: ['whatsapp-1'], chatDenylist: [] } }),
    );
    const call = async (name: string, args: Record<string, unknown>) => narrowed.callTool({ name, arguments: args });

    const found = JSON.parse(text(await call('search_messages', { query: 'hello' })));
    expect(found.items.map((m: { id: string }) => m.id)).toEqual(['msg-1']);
    const chats = JSON.parse(text(await call('search_chats', {})));
    expect(chats.items.map((c: { id: string }) => c.id)).toEqual(['!chat1:beeper.com']);
    for (const denied of [
      await call('get_chat', { chatId: '!no-account:beeper.com' }),
      await call('list_messages', { chatId: '!no-account:beeper.com' }),
    ]) {
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain('read.accountAllowlist');
      expect(text(denied)).not.toContain('hello from nowhere');
    }
  });

  it("audits Beeper's failure by its code, never Beeper's text, which can quote a message, while Claude gets the text", async () => {
    for (const [status, code] of [
      [500, 'provider_error'],
      [404, 'not_found'],
    ] as const) {
      mock.forcedError = { status, message: 'cannot render "meet me behind the mill at 8"' };
      const result = await client.callTool({ name: 'list_messages', arguments: { chatId: '!chat1:beeper.com' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`${code}: `);
      expect(text(result)).toContain('behind the mill');
      expect(audit.entries.at(-1)).toMatchObject({ action: 'listMessages', decision: 'allowed', outcome: 'error', error: code });
    }
    expect(JSON.stringify(audit.entries)).not.toContain('behind the mill');
  });

  it('allowlisted send reaches the wire and is audited with its text', async () => {
    const result = await client.callTool({
      name: 'send_message',
      arguments: { chatId: '!chat1:beeper.com', text: 'on my way' },
    });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(text(result)).pendingMessageId).toMatch(/^pending-/);

    const wireSend = mock.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    expect(wireSend?.body).toEqual({ text: 'on my way' });
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'sendMessage',
      decision: 'allowed',
      outcome: 'ok',
      context: { chatId: '!chat1:beeper.com', text: 'on my way' },
    });
  });

  it('non-allowlisted send is blocked before the wire and names the rule', async () => {
    const before = mock.requests.length;
    const result = await client.callTool({
      name: 'send_message',
      arguments: { chatId: '!secret:beeper.com', text: 'leak' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('read.chatDenylist');
    expect(mock.requests.length).toBe(before); // nothing hit the network
  });

  it('rate limit trips on the wire path after the allowed budget', async () => {
    const send = () =>
      client.callTool({
        name: 'send_message',
        arguments: { chatId: '!chat1:beeper.com', text: 'ping' },
      });
    expect((await send()).isError ?? false).toBe(false);
    expect((await send()).isError ?? false).toBe(false);
    const third = await send();
    expect(third.isError).toBe(true);
    expect(text(third)).toContain('send.maxMessagesPerHour');
  });

  it('mark_chat_read, where policy allows it, marks the chat read and says so', async () => {
    const reader = await connect(policy({ markRead: true }));
    const result = await reader.callTool({
      name: 'mark_chat_read',
      arguments: { chatId: '!chat1:beeper.com' },
    });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(text(result))).toEqual({ ok: true });
    expect(mock.requests.some((r) => r.method === 'POST' && r.path === '/v1/chats/!chat1:beeper.com/read')).toBe(true);
  });

  it('mark_chat_read is denied by this policy (capability off)', async () => {
    const result = await client.callTool({
      name: 'mark_chat_read',
      arguments: { chatId: '!chat1:beeper.com' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('capabilities.markRead');
  });
});
