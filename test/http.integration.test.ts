import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/mcp/server.js';
import { startHttpMcpServer, type RunningHttpServer } from '../src/mcp/http.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { FakeMessenger, makeChat } from './fake-messenger.js';

/**
 * The hosted path: a remote MCP client over real HTTP — auth gating, tool
 * flow, and shared rate-limit state across separate HTTP requests (the
 * per-request MCP servers must all see the ONE policy engine).
 */
describe('HTTP MCP transport', () => {
  const AUTH_TOKEN = 'test-mcp-token-0123456789abcdef';
  let running: RunningHttpServer;
  let fake: FakeMessenger;

  beforeAll(async () => {
    fake = new FakeMessenger();
    fake.chats = [makeChat({ id: 'chat-1' })];
    const messenger = new GuardedMessenger(
      fake,
      new PolicyEngine(
        parsePolicy({
          version: 1,
          capabilities: { read: true, send: true, markRead: false },
          send: { chatAllowlist: ['chat-1'], maxMessagesPerHour: 2, maxCharsPerMessage: 100 },
        }),
      ),
      new MemoryAuditLogger(),
    );
    running = await startHttpMcpServer({
      createMcpServer: () => createMcpServer(messenger, '0.0.0-test'),
      authToken: AUTH_TOKEN,
      port: 0,
    });
  });

  afterAll(async () => {
    await running.close();
  });

  const url = () => new URL(`http://127.0.0.1:${running.port}/mcp`);

  const connect = async (token: string) => {
    const client = new Client({ name: 'http-test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(url(), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  };

  it('rejects requests without a valid bearer token', async () => {
    const noAuth = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(badAuth.status).toBe(401);
  });

  it('serves an unauthenticated healthz that leaks nothing', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('authenticated clients get the full curated tool surface', async () => {
    const client = await connect(AUTH_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search_chats');
    expect(tools.map((t) => t.name)).toContain('send_message');
    await client.close();
  });

  it('tools work end to end and policy state is shared across separate HTTP requests', async () => {
    const client = await connect(AUTH_TOKEN);
    const send = () =>
      client.callTool({ name: 'send_message', arguments: { chatId: 'chat-1', text: 'hi' } });

    expect((await send()).isError ?? false).toBe(false);
    expect((await send()).isError ?? false).toBe(false);
    const third = await send(); // rate limit (2/hour) must hold across requests
    expect(third.isError).toBe(true);
    const content = third.content as Array<{ text: string }>;
    expect(content[0]!.text).toContain('send.maxMessagesPerHour');
    expect(fake.sent).toHaveLength(2);
    await client.close();
  });

  it('rejects non-POST methods on /mcp so stateless mode cannot leak SSE sockets', async () => {
    const headers = { authorization: `Bearer ${AUTH_TOKEN}`, accept: 'text/event-stream' };
    const get = await fetch(url(), { method: 'GET', headers });
    expect(get.status).toBe(405);
    const del = await fetch(url(), { method: 'DELETE', headers });
    expect(del.status).toBe(405);
  });

  it('rejects oversized bodies with 413 instead of buffering them', async () => {
    const res = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1, params: { pad: 'x'.repeat(5 * 1024 * 1024) } }),
    }).catch(() => null);
    // Either a clean 413 or a destroyed socket mid-upload — both mean rejected.
    if (res) expect(res.status).toBe(413);

    const malformed = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTH_TOKEN}` },
      body: '{ not json',
    });
    expect(malformed.status).toBe(400);
  });

  it('refuses to start with a weak auth token', async () => {
    await expect(
      startHttpMcpServer({
        createMcpServer: () => createMcpServer(new FakeMessenger() as never, '0.0.0-test'),
        authToken: 'short',
        port: 0,
      }),
    ).rejects.toThrow(/at least 16 characters/);
  });
});
