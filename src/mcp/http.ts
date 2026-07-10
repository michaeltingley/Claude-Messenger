import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * HTTP transport for the MCP server — what makes Claude Messenger hostable.
 *
 * A VM runs this 24/7 next to Beeper Server; remote Claude clients
 * (claude.ai connectors, Claude Code on any machine) speak Streamable HTTP
 * to /mcp. Design decisions:
 *
 * - Auth is a DEDICATED bearer token (CLAUDE_MESSENGER_MCP_TOKEN), never the
 *   Beeper token: revoking Claude's access must not require rotating the
 *   all-powerful Beeper credential, and the Beeper token never leaves the
 *   host.
 * - Stateless MCP: a fresh McpServer+transport per request (the SDK's
 *   stateless pattern). The factory closes over the ONE GuardedMessenger,
 *   so policy, audit, and rate-limit state stay shared across requests.
 * - Binds 127.0.0.1 unless explicitly overridden — exposure is expected to
 *   go through Tailscale/cloudflared, not a raw public port.
 */
export interface HttpServerOptions {
  /** Builds the per-request MCP server over the shared guarded messenger. */
  createMcpServer: () => McpServer;
  /** Required: requests without `Authorization: Bearer <token>` are 401s. */
  authToken: string;
  port: number;
  host?: string;
}

export interface RunningHttpServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export async function startHttpMcpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  if (options.authToken.length < 16) {
    throw new Error(
      'CLAUDE_MESSENGER_MCP_TOKEN must be at least 16 characters — generate one with: openssl rand -hex 32',
    );
  }
  const expected = sha256(options.authToken);
  const host = options.host ?? '127.0.0.1';

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    return timingSafeEqual(sha256(header.slice('Bearer '.length)), expected);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Unauthenticated liveness probe for systemd/monitoring; returns no data.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!authorized(req)) {
      res
        .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const server = options.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, host, resolve);
  });

  return {
    port: (httpServer.address() as AddressInfo).port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
