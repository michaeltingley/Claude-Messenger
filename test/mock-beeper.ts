import { createHash, randomBytes } from 'node:crypto';
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

/** What Beeper's "Approve connection" box was asked to approve (the callback's JSON body). */
export interface ApprovalRequest {
  mode?: string;
  clientInfo?: { name?: string; clientID?: string };
  scopes?: string[];
  redirectUri?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/**
 * How the person at Beeper's screen answers the box: approve, with the
 * "Expires in" choice (omitted means Never) and the scopes the "Allow
 * sensitive actions" toggle ends up granting (omitted means as asked);
 * decline; or never answer, until Beeper closes the box itself.
 * `{ approve: false, error }` with another error stands for Beeper failing.
 */
export type ApprovalDecision =
  | { approve: true; expiresInSeconds?: number; scopes?: string[] }
  | { approve: false; error?: string }
  | 'no-answer';

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  scope: string;
}

interface PendingCode {
  clientId: string;
  scope: string;
  codeChallenge: string;
  expiresInSeconds: number | undefined;
}

export interface IssuedToken {
  scope: string;
  revoked: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

const isLoopbackRedirect = (uri: string): boolean => {
  try {
    const url = new URL(uri);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/** Loopback redirects match on scheme, host and path; any port is allowed (RFC 8252 §7.3). */
const sameRedirect = (a: string, b: string): boolean => {
  const x = new URL(a);
  const y = new URL(b);
  return x.protocol === y.protocol && x.hostname === y.hostname && x.pathname === y.pathname;
};

const htmlPage = (title: string, message: string) =>
  `<!doctype html><html><head><title>${title}</title><script>/* posts to /oauth/authorize/callback */</script></head>` +
  `<body><h1>${title}</h1><p>${message}</p></body></html>`;

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

  /** The person at Beeper's screen. Approves with "Never" unless a test says otherwise. */
  decide: (request: ApprovalRequest) => ApprovalDecision = () => ({ approve: true });
  /** Every approval box Beeper was asked to open, in order. */
  approvalRequests: ApprovalRequest[] = [];
  /** Tokens issued through OAuth, by token. */
  issuedTokens = new Map<string, IssuedToken>();
  /** When false, the OAuth routes don't exist, as in a Beeper Desktop older than its OAuth server. */
  oauthEnabled = true;
  /** How long Beeper keeps an unanswered box open before closing it with `server_error` (two minutes in 4.3.176). */
  boxLifetimeMs = 120_000;
  /** Whether an account is signed in. Signed out, the API still answers, and /v1/app/setup says so. */
  signedIn = true;
  /** The "Beeper Desktop API" setting switched off: every route answers 404 `disabled`. */
  apiDisabled = false;

  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, PendingCode>();
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    // An approval nobody answered holds its connection open; don't wait on it.
    this.server?.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((err) => (err ? reject(err) : resolve())) : resolve(),
    );
  }

  /** True if this token may call the API: the fixed test token, or an OAuth token not revoked. */
  private authorized(header: string | undefined): boolean {
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (token === undefined) return false;
    if (token === this.token) return true;
    const issued = this.issuedTokens.get(token);
    return issued !== undefined && !issued.revoked;
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

    if (this.apiDisabled) {
      return send(404, { message: 'Beeper Client API is disabled', code: 'disabled' });
    }
    // Signed out, the setup state is public. Signed in, it needs a token, so
    // asking without one is how a client learns an account is there.
    if (req.method === 'GET' && path === '/v1/app/setup') {
      if (!this.signedIn) return send(200, { state: 'needs-login', e2ee: { initialized: false } });
      if (!this.authorized(req.headers.authorization)) {
        return send(401, { message: 'Unauthorized: Invalid or missing token', code: 'unauthorized' });
      }
      return send(200, { state: 'ready' });
    }

    // Like the real Client API, /v1/info and the OAuth routes are
    // unauthenticated (the SDK deliberately sends no bearer token to /v1/info).
    const isOAuth = path.startsWith('/oauth/');
    if (isOAuth) {
      if (!this.oauthEnabled) return error(404, 'not_found', `no route: ${req.method} ${path}`);
      return this.handleOAuth(req, res, path, url.searchParams, body);
    }
    const isInfo = path === '/v1/info';
    if (!isInfo && !this.authorized(req.headers.authorization)) {
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
        endpoints: {
          mcp: '/v0/mcp',
          spec: '/v1/spec',
          ws_events: '/v1/ws',
          oauth: {
            authorization_endpoint: 'http://127.0.0.1:23373/oauth/authorize',
            token_endpoint: 'http://127.0.0.1:23373/oauth/token',
            introspection_endpoint: 'http://127.0.0.1:23373/oauth/introspect',
            userinfo_endpoint: 'http://127.0.0.1:23373/oauth/userinfo',
            revocation_endpoint: 'http://127.0.0.1:23373/oauth/revoke',
            registration_endpoint: 'http://127.0.0.1:23373/oauth/register',
          },
        },
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

  /**
   * Beeper Desktop 4.3.176's OAuth server, from its OpenAPI spec and probes
   * of the real app: dynamic registration, an authorize page that validates
   * and renders HTML, a callback that holds the request open until the
   * person decides in the app, and a PKCE (S256) token exchange.
   */
  private async handleOAuth(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Promise<void> {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const html = (status: number, page: string) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(page);
    };
    const form = typeof body === 'string' ? new URLSearchParams(body) : new URLSearchParams();

    if (req.method === 'POST' && path === '/oauth/register') {
      const meta = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown; scope?: unknown };
      const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u) => typeof u === 'string') : [];
      if (typeof meta.client_name !== 'string' || uris.length === 0 || !uris.every(isLoopbackRedirect)) {
        return json(400, { error: 'invalid_client_metadata', error_description: 'client_name and loopback redirect_uris are required' });
      }
      const client: RegisteredClient = {
        clientId: randomBytes(16).toString('base64url').slice(0, 21),
        redirectUris: uris,
        scope: typeof meta.scope === 'string' ? meta.scope : 'read write',
      };
      this.clients.set(client.clientId, client);
      return json(201, {
        client_id: client.clientId,
        client_name: meta.client_name,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: uris,
        scope: client.scope,
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        authorization_endpoint: 'http://127.0.0.1:23373/oauth/authorize',
        token_endpoint: 'http://127.0.0.1:23373/oauth/token',
      });
    }

    if (req.method === 'GET' && path === '/oauth/authorize') {
      const invalid = (message: string) => html(400, htmlPage('Invalid Request', message));
      const clientId = query.get('client_id');
      const redirect = query.get('redirect_uri');
      if (!clientId) return invalid('Missing client_id parameter.');
      if (!redirect) return invalid('Missing redirect_uri parameter.');
      if (query.get('response_type') !== 'code') {
        return invalid('Invalid or missing response_type parameter. Only "code" is supported.');
      }
      if (!query.get('code_challenge')) return invalid('PKCE code_challenge is required for public clients.');
      const method = query.get('code_challenge_method');
      if (method !== null && method !== 'S256') return invalid('Only S256 code_challenge_method is supported.');
      const client = this.clients.get(clientId);
      if (client === undefined) {
        if (!isLoopbackRedirect(redirect)) {
          return invalid('Invalid redirect_uri. Use a loopback HTTP/HTTPS or private-use URI scheme redirect.');
        }
      } else {
        if (!client.redirectUris.some((u) => sameRedirect(u, redirect))) {
          return invalid('Invalid redirect_uri. Must match one of the registered redirect URIs.');
        }
        const allowed = new Set(client.scope.split(' '));
        const asked = (query.get('scope') ?? 'read write').split(' ').filter(Boolean);
        if (!asked.every((s) => allowed.has(s))) return invalid('Requested scope exceeds registered scope for this client.');
      }
      return html(200, htmlPage('Continue in the app', 'Approve this connection in Beeper Desktop.'));
    }

    if (req.method === 'POST' && path === '/oauth/authorize/callback') {
      const request = (body ?? {}) as ApprovalRequest;
      const invalid = (description: string) =>
        json(400, { error: 'invalid_request', error_description: description, state: request.state });
      const client = this.clients.get(request.clientInfo?.clientID ?? '');
      if (client === undefined) return invalid('Unknown client');
      if (!request.redirectUri || !client.redirectUris.some((u) => sameRedirect(u, request.redirectUri!))) {
        return invalid('Invalid redirect_uri');
      }
      if (request.codeChallengeMethod !== 'S256' || !request.codeChallenge) {
        return invalid('PKCE code_challenge with S256 is required');
      }
      this.approvalRequests.push(request);
      const decision = this.decide(request);
      if (decision === 'no-answer') {
        // The box stays open until the client gives up, or until Beeper
        // closes it and reports that as a server error.
        const closed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), this.boxLifetimeMs);
          res.on('close', () => {
            clearTimeout(timer);
            resolve(false);
          });
        });
        if (closed) json(200, { error: 'server_error', state: request.state });
        return;
      }
      if (!decision.approve) return json(200, { error: decision.error ?? 'access_denied', state: request.state });
      const code = randomBytes(24).toString('base64url');
      this.codes.set(code, {
        clientId: client.clientId,
        // The box's toggle wins over the request, as in Beeper's approveToken.
        scope: (decision.scopes ?? request.scopes ?? ['read']).join(' '),
        codeChallenge: request.codeChallenge,
        expiresInSeconds: decision.expiresInSeconds,
      });
      return json(200, { code, state: request.state });
    }

    if (req.method === 'POST' && path === '/oauth/token') {
      const code = form.get('code') ?? '';
      const pending = this.codes.get(code);
      if (form.get('grant_type') !== 'authorization_code') {
        return json(400, { error: 'unsupported_grant_type', error_description: 'Only authorization_code is supported' });
      }
      if (pending === undefined) {
        return json(400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      }
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      const clientId = form.get('client_id');
      if (clientId !== null && clientId !== pending.clientId) {
        return json(400, { error: 'invalid_grant', error_description: 'Client mismatch' });
      }
      this.codes.delete(code); // single use
      const token = randomBytes(32).toString('base64url');
      this.issuedTokens.set(token, { scope: pending.scope, revoked: false });
      return json(200, {
        access_token: token,
        token_type: 'Bearer',
        scope: pending.scope,
        ...(pending.expiresInSeconds !== undefined && { expires_in: pending.expiresInSeconds }),
      });
    }

    if (req.method === 'POST' && path === '/oauth/revoke') {
      const issued = this.issuedTokens.get(form.get('token') ?? '');
      if (issued) issued.revoked = true;
      res.writeHead(200);
      res.end();
      return;
    }

    json(404, { message: 'Not found', code: 'not_found' });
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
