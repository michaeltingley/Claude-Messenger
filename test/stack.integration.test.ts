import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { MockBeeperServer, wireChat, wireMessage } from './mock-beeper.js';

/**
 * Full-stack integration: MCP client → curated tools → policy guard →
 * Beeper adapter → HTTP wire. This is the exact path a Claude tool call
 * takes in production, minus DNS.
 */
describe('full stack: MCP → policy → adapter → HTTP', () => {
  let mock: MockBeeperServer;
  let audit: MemoryAuditLogger;
  let client: Client;

  const policy = () =>
    parsePolicy({
      version: 1,
      capabilities: { read: true, send: true, markRead: false },
      read: { accountAllowlist: '*', chatDenylist: ['!secret:beeper.com'] },
      send: { chatAllowlist: ['!chat1:beeper.com'], maxMessagesPerHour: 2, maxCharsPerMessage: 100 },
    });

  beforeEach(async () => {
    mock = new MockBeeperServer();
    const baseUrl = await mock.start();
    mock.chats = [
      wireChat(),
      wireChat({ id: '!secret:beeper.com', title: 'Secret Chat' }),
    ];
    mock.messages = [
      wireMessage(),
      wireMessage({ id: 'msg-secret', chatID: '!secret:beeper.com', text: 'hello secret' }),
    ];

    audit = new MemoryAuditLogger();
    const messenger = new GuardedMessenger(
      new BeeperMessenger({ accessToken: mock.token, baseUrl, maxRetries: 0 }),
      new PolicyEngine(policy()),
      audit,
    );
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(messenger, '0.0.0-test').connect(st), client.connect(ct)]);
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

  it('mark_chat_read is denied by this policy (capability off)', async () => {
    const result = await client.callTool({
      name: 'mark_chat_read',
      arguments: { chatId: '!chat1:beeper.com' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('capabilities.markRead');
  });
});
