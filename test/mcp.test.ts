import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { DEFAULT_POLICY, PolicyEngine } from '../src/policy/policy.js';
import { FakeMessenger, makeChat, makeMessage } from './fake-messenger.js';

async function connect(fake: FakeMessenger) {
  const guarded = new GuardedMessenger(fake, new PolicyEngine(DEFAULT_POLICY), new MemoryAuditLogger());
  const server = createMcpServer(guarded);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP server', () => {
  it('exposes the curated tool set and nothing else', async () => {
    const client = await connect(new FakeMessenger());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_chat',
      'list_accounts',
      'list_messages',
      'mark_chat_read',
      'search_chats',
      'search_messages',
      'send_message',
      'whoami',
    ]);
  });

  it('search_chats returns policy-filtered chats as JSON', async () => {
    const fake = new FakeMessenger();
    fake.chats = [makeChat({ id: 'c1', title: 'Alice' })];
    fake.messages = [makeMessage({ chatId: 'c1' })];
    const client = await connect(fake);

    const result = await client.callTool({ name: 'search_chats', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const page = JSON.parse(content[0]!.text);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('c1');
  });

  it('send_message surfaces policy denials as tool errors, not protocol errors', async () => {
    const fake = new FakeMessenger();
    fake.chats = [makeChat({ id: 'c1' })];
    const client = await connect(fake);

    const result = await client.callTool({
      name: 'send_message',
      arguments: { chatId: 'c1', text: 'hi' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain('Denied by policy (capabilities.send)');
    expect(fake.sent).toHaveLength(0);
  });
});
