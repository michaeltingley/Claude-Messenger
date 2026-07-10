import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process HTTP stand-in for the Beeper Client API, faithful to the wire
 * protocol the @beeper/desktop-api SDK actually speaks (paths, methods,
 * bearer auth, cursor envelope shapes) so adapter integration tests exercise
 * the real HTTP layer.
 */

export interface WireChat {
  id: string;
  accountID: string;
  network: string;
  type: 'single' | 'group';
  title: string;
  unreadCount: number;
  participants: { items: Array<{ id: string; fullName?: string }>; hasMore: boolean; total: number };
  lastActivity?: string;
}

export interface WireMessage {
  id: string;
  accountID: string;
  chatID: string;
  senderID: string;
  senderName?: string;
  isSender?: boolean;
  sortKey: string;
  timestamp: string;
  text?: string;
  attachments?: Array<{ type: 'unknown' | 'img' | 'video' | 'audio'; fileName?: string }>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

export function wireChat(overrides: Partial<WireChat> = {}): WireChat {
  return {
    id: '!chat1:beeper.com',
    accountID: 'whatsapp-1',
    network: 'whatsapp',
    type: 'single',
    title: 'Alice',
    unreadCount: 2,
    participants: { items: [{ id: 'alice', fullName: 'Alice' }], hasMore: false, total: 1 },
    lastActivity: '2026-07-09T12:00:00.000Z',
    ...overrides,
  };
}

export function wireMessage(overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    id: 'msg-1',
    accountID: 'whatsapp-1',
    chatID: '!chat1:beeper.com',
    senderID: 'alice',
    senderName: 'Alice',
    isSender: false,
    sortKey: '1',
    timestamp: '2026-07-09T12:00:00.000Z',
    text: 'hello from alice',
    ...overrides,
  };
}

const cursorEnvelope = <T>(items: T[]) => ({
  items,
  hasMore: false,
  oldestCursor: items.length ? 'cursor-oldest' : null,
  newestCursor: items.length ? 'cursor-newest' : null,
});

export class MockBeeperServer {
  readonly token = 'test-token-123';
  chats: WireChat[] = [];
  messages: WireMessage[] = [];
  requests: RecordedRequest[] = [];
  /** When set, every route responds with this status and an error body. */
  forcedError: { status: number; code?: string } | undefined;

  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((err) => (err ? reject(err) : resolve())) : resolve(),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = decodeURIComponent(url.pathname);
    const body = await this.readBody(req);
    this.requests.push({ method: req.method ?? '', path, query: url.searchParams, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, code: string, message: string) =>
      send(status, { error: { code, message } });

    // Like the real Client API, /v1/info is the unauthenticated discovery
    // endpoint (the SDK deliberately sends no bearer token to it).
    const isInfo = path === '/v1/info';
    if (!isInfo && req.headers.authorization !== `Bearer ${this.token}`) {
      return error(401, 'unauthorized', 'Invalid access token');
    }
    if (this.forcedError) {
      return error(this.forcedError.status, this.forcedError.code ?? 'forced', 'Forced test error');
    }

    const messagesMatch = /^\/v1\/chats\/([^/]+)\/messages$/.exec(path);
    const readMatch = /^\/v1\/chats\/([^/]+)\/read$/.exec(path);
    const chatMatch = /^\/v1\/chats\/([^/]+)$/.exec(path);

    if (req.method === 'GET' && path === '/v1/info') {
      return send(200, {
        app: { bundle_id: 'com.test.mock', name: 'MockBeeper', version: '9.9.9' },
        endpoints: { mcp: '/v0/mcp', spec: '/spec', ws_events: '/v1/ws', oauth: {} },
        platform: { arch: 'x64', os: 'linux' },
        server: {
          base_url: 'http://127.0.0.1',
          hostname: 'mock',
          mcp_enabled: true,
          port: 23373,
          remote_access: false,
          status: 'ok',
        },
      });
    }
    if (req.method === 'GET' && path === '/v1/accounts') {
      const accounts = [...new Map(this.chats.map((c) => [c.accountID, c])).values()].map((c) => ({
        accountID: c.accountID,
        network: c.network,
        bridge: { id: c.accountID, provider: 'cloud', type: c.network },
        user: { id: 'me', fullName: 'Test User', isSelf: true },
      }));
      return send(200, accounts);
    }
    if (req.method === 'GET' && path === '/v1/chats/search') {
      const q = url.searchParams.get('query')?.toLowerCase();
      const items = q ? this.chats.filter((c) => c.title.toLowerCase().includes(q)) : this.chats;
      return send(200, cursorEnvelope(items));
    }
    if (req.method === 'GET' && path === '/v1/messages/search') {
      const q = url.searchParams.get('query')?.toLowerCase();
      const items = q ? this.messages.filter((m) => m.text?.toLowerCase().includes(q)) : this.messages;
      return send(200, cursorEnvelope(items));
    }
    if (req.method === 'GET' && messagesMatch) {
      const items = this.messages.filter((m) => m.chatID === messagesMatch[1]);
      return send(200, cursorEnvelope(items));
    }
    if (req.method === 'POST' && messagesMatch) {
      return send(200, { chatID: messagesMatch[1], pendingMessageID: `pending-${this.requests.length}` });
    }
    if (req.method === 'POST' && readMatch) {
      const chat = this.chats.find((c) => c.id === readMatch[1]);
      return chat ? send(200, { ...chat, unreadCount: 0 }) : error(404, 'not_found', 'chat not found');
    }
    if (req.method === 'GET' && chatMatch) {
      const chat = this.chats.find((c) => c.id === chatMatch[1]);
      return chat ? send(200, chat) : error(404, 'not_found', 'chat not found');
    }
    return error(404, 'not_found', `no route: ${req.method} ${path}`);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
