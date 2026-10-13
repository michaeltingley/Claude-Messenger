import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { AccessGrant, AccessProgress, AccessRequest, AccessRequester } from '../../core/access.js';
import {
  AccessDeniedError,
  AccessMismatchError,
  AccessTimeoutError,
  ConnectionError,
  ProviderError,
} from '../../core/errors.js';

/**
 * Gets a Beeper access token through Beeper Desktop's own approval box.
 *
 * Beeper Desktop is an OAuth 2.0 authorization server: dynamic client
 * registration, PKCE (S256 only), and consent in the app's own window. In a
 * browser, GET /oauth/authorize renders a "Continue in the app" page whose
 * script POSTs the request to /oauth/authorize/callback. That POST opens the
 * "Approve connection" box and answers with an authorization code once the
 * owner decides. This client makes the same two requests itself, so no
 * browser or redirect listener is involved, and the code and token travel
 * only between Beeper and this process.
 *
 * What Beeper Desktop 4.3.176 (Client API 5.0.0) does here, read from its
 * code and its OpenAPI spec:
 * - The box grants access to the signed-in account, so this waits for one.
 *   Without a token, GET /v1/app/setup answers 200 while signed out and 401
 *   once an account is signed in.
 * - The callback answers `access_denied` when the owner declines. It answers
 *   `server_error` when Beeper closes a box nobody answered, two minutes in,
 *   and then this opens a fresh one, until its own deadline.
 * - The owner picks the token's lifetime and whether it may write, whatever
 *   was asked. A token this app can't keep is revoked, not returned.
 */

/**
 * Beeper requires a registered loopback redirect. Nothing is ever sent to it:
 * the code comes back in the callback's response.
 */
const REDIRECT_URI = 'http://127.0.0.1:47613/callback';

/** Bound on every request that doesn't wait for a person. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How often to check whether an account has been signed in. */
const SIGN_IN_POLL_MS = 1_000;

/**
 * Beeper also answers `server_error` when it fails outright, which takes
 * milliseconds, not the two minutes after which it closes an unanswered box.
 * An answer sooner than this is reported, not met with another box.
 */
const MIN_BOX_LIFETIME_MS = 3_000;

const APPROVED_CONNECTIONS = 'Settings → Integrations → Approved connections';

export interface BeeperAccessRequesterOptions {
  /** Beeper Client API endpoint, as in `BeeperMessengerOptions.baseUrl`. */
  baseUrl: string;
}

const RegisteredClient = z.object({ client_id: z.string().min(1) });

const Decision = z.object({
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  state: z.string().optional(),
});

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string(),
  /** Absent when the owner chose "Never" under "Expires in". */
  expires_in: z.number().nullish(),
});

const OAuthError = z.object({ error: z.string(), error_description: z.string().optional() });

/** What Beeper answers on every route while its Desktop API is switched off. */
const ApiDisabled = z.object({ code: z.literal('disabled') });

type Progress = (progress: AccessProgress) => void;

export class BeeperAccessRequester implements AccessRequester {
  private readonly baseUrl: string;

  constructor(options: BeeperAccessRequesterOptions) {
    this.baseUrl = options.baseUrl;
  }

  instructions(request: AccessRequest): readonly string[] {
    return [
      "Approve the connection in Beeper's own window:",
      '  1. If Beeper asks you to sign in, do that first: your emailed code, then your recovery key.',
      `  2. Beeper then shows an "Approve connection" box for ${request.clientName}. In it:`,
      '     - Expires in: choose Never. A token that expires would stop working, and nothing here renews it.',
      request.write
        ? '     - Allow sensitive actions: turn it on, so sending can work.'
        : '     - Allow sensitive actions: leave it off.',
      '     - Press Approve.',
      '  If the box says the request has timed out, press Close; a new one follows.',
    ];
  }

  async requestAccess(request: AccessRequest): Promise<AccessGrant> {
    const deadline = Date.now() + request.timeoutMs;
    const progress: Progress = request.onProgress ?? (() => {});
    await this.awaitSignIn(request, deadline, progress);

    const scope = request.write ? 'read write' : 'read';
    const clientId = await this.register(request.clientName, scope);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = s256(verifier);
    const state = randomBytes(16).toString('base64url');

    // The consent page is where Beeper validates the request (client,
    // redirect, scope, PKCE) and reports problems in words, so load it first,
    // exactly as a browser would.
    const authorize = this.url('/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const page = await this.send('GET', authorize);
    if (page.status !== 200) throw this.failure('start the approval', page);

    const code = await this.awaitApproval(request, deadline, progress, state, {
      mode: 'oauth2',
      clientInfo: { name: request.clientName, clientID: clientId },
      scopes: scope.split(' '),
      redirectUri: REDIRECT_URI,
      scope,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    const token = await this.exchange(code, verifier, clientId);
    // Anything beyond read counts as write: an unknown scope is assumed to
    // grant more, never less.
    const write = token.scope.split(' ').some((s) => s !== '' && s !== 'read');
    await this.refuseUnkeepable(token.access_token, {
      unaskedWrite: write && !request.write,
      expiresIn: token.expires_in ?? undefined,
    });
    return { token: token.access_token, write, revoke: () => this.revoke(token.access_token) };
  }

  /** Waits until Beeper has an account signed in, since the box grants access to it. */
  private async awaitSignIn(request: AccessRequest, deadline: number, progress: Progress): Promise<void> {
    let told = false;
    for (;;) {
      const res = await this.send('GET', this.url('/v1/app/setup'));
      // Signed in, Beeper guards this route with a token, which this request doesn't carry.
      if (res.status === 401 || res.status === 403) return;
      if (res.status !== 200) throw this.failure('say whether it is signed in', res);

      if (!told) progress({ kind: 'sign-in-required' });
      told = true;
      if (Date.now() + SIGN_IN_POLL_MS >= deadline) {
        throw new AccessTimeoutError(
          `Nobody signed in to Beeper within ${describeWait(request.timeoutMs)}. Sign in on its screen, then run this again.`,
        );
      }
      await sleep(SIGN_IN_POLL_MS);
    }
  }

  /** Dynamic client registration (RFC 7591); Beeper issues public clients only. */
  private async register(clientName: string, scope: string): Promise<string> {
    const res = await this.send('POST', this.url('/oauth/register'), {
      json: {
        client_name: clientName,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope,
      },
    });
    if (res.status === 404 && !isApiDisabled(res)) {
      throw new ProviderError(
        `Beeper at ${this.baseUrl} has no OAuth server to approve this app. Update Beeper Desktop, ` +
          `or mint a token in Beeper under ${APPROVED_CONNECTIONS} and put it in .env yourself.`,
      );
    }
    if (res.status !== 201 && res.status !== 200) throw this.failure('register this app', res);
    return parseJson(RegisteredClient, res.body, 'client registration').client_id;
  }

  /**
   * Opens Beeper's approval box and waits for the owner's decision, opening a
   * fresh box whenever Beeper closes one unanswered, until the deadline.
   */
  private async awaitApproval(
    request: AccessRequest,
    deadline: number,
    progress: Progress,
    state: string,
    body: unknown,
  ): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw unanswered(request);
      progress({ kind: 'approval-requested', attempt });
      const opened = Date.now();
      let res: HttpResponse;
      try {
        res = await this.send('POST', this.url('/oauth/authorize/callback'), { json: body, timeoutMs: remaining });
      } catch (err) {
        if (err instanceof RequestTimedOut) throw unanswered(request, err);
        throw err;
      }
      if (res.status !== 200) throw this.failure('ask for approval', res);

      const decision = parseJson(Decision, res.body, 'approval decision');
      if (decision.state !== undefined && decision.state !== state) {
        throw new ProviderError('Beeper answered a different approval request (state mismatch); nothing was saved.');
      }
      if (decision.error === undefined && decision.code !== undefined) return decision.code;
      if (decision.error === 'access_denied') {
        throw new AccessDeniedError('The connection was declined in Beeper. Run this again and press Approve.');
      }
      if (decision.error === 'server_error' && Date.now() - opened >= MIN_BOX_LIFETIME_MS) continue;
      throw new ProviderError(`Beeper could not ask for approval (${decision.error ?? 'it sent no code'}).`);
    }
  }

  /** Authorization code + PKCE verifier → access token. */
  private async exchange(code: string, verifier: string, clientId: string): Promise<z.infer<typeof TokenResponse>> {
    const res = await this.send('POST', this.url('/oauth/token'), {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId },
    });
    if (res.status !== 200) throw this.failure('exchange the approval for a token', res);
    return parseJson(TokenResponse, res.body, 'token response');
  }

  /**
   * The box lets the owner grant more than was asked: a lifetime, and write
   * access. Either makes the token one this app won't keep, so it must not
   * keep working either.
   */
  private async refuseUnkeepable(
    token: string,
    terms: { unaskedWrite: boolean; expiresIn: number | undefined },
  ): Promise<void> {
    const problems: string[] = [];
    const fixes: string[] = [];
    if (terms.unaskedWrite) {
      problems.push('Beeper granted write access (Allow sensitive actions was on), which was not asked for.');
      fixes.push('leave Allow sensitive actions off');
    }
    if (terms.expiresIn !== undefined) {
      const expiry = new Date(Date.now() + terms.expiresIn * 1000).toISOString();
      problems.push(`Beeper granted a token that expires ${expiry}, and nothing here renews it.`);
      fixes.push('choose Never under Expires in');
    }
    if (problems.length === 0) return;

    const revoked = await this.revoke(token).then(
      () => true,
      () => false,
    );
    throw new AccessMismatchError(
      `${problems.join(' ')} ` +
        (revoked
          ? 'It was revoked and nothing was saved. '
          : `Nothing was saved, but it works until you revoke it in Beeper: ${APPROVED_CONNECTIONS}. `) +
        `Run this again and ${fixes.join(', and ')}.`,
    );
  }

  private async revoke(token: string): Promise<void> {
    const res = await this.send('POST', this.url('/oauth/revoke'), {
      form: { token, token_type_hint: 'access_token' },
    });
    if (res.status !== 200) throw this.failure('revoke the token', res);
  }

  private url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  /** An actionable error for an unexpected answer. OAuth error bodies never carry the token. */
  private failure(action: string, res: HttpResponse): ProviderError {
    if (isApiDisabled(res)) {
      return new ProviderError(
        `Beeper Desktop's API is switched off, so it cannot ${action}. Turn it on in Beeper's settings, then run this again.`,
      );
    }
    let detail = pageText(res.body);
    try {
      const err = OAuthError.parse(JSON.parse(res.body));
      detail = err.error_description ? `${err.error}: ${err.error_description}` : err.error;
    } catch {
      // Not an OAuth error body; the page text is the best description.
    }
    return new ProviderError(`Beeper could not ${action} (HTTP ${res.status}): ${detail}`);
  }

  /**
   * One HTTP exchange over node:http. Deliberately not fetch: Node's fetch
   * gives up on a response after 5 minutes, and the approval request waits
   * for a person for as long as `timeoutMs` allows.
   */
  private send(
    method: 'GET' | 'POST',
    url: URL,
    options: { json?: unknown; form?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    } else if (options.form !== undefined) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', fail);
      });
      const timer = setTimeout(() => req.destroy(new RequestTimedOut(timeoutMs)), timeoutMs);
      function fail(err: Error) {
        clearTimeout(timer);
        if (err instanceof RequestTimedOut && options.timeoutMs !== undefined) return reject(err);
        reject(
          new ConnectionError(
            `Cannot reach Beeper Desktop at ${url.origin} (${err.message}). Is Beeper Desktop running with its Desktop API on?`,
            { cause: err },
          ),
        );
      }
      req.on('error', fail);
      req.end(body);
    });
  }
}

interface HttpResponse {
  status: number;
  body: string;
}

class RequestTimedOut extends Error {
  constructor(timeoutMs: number) {
    super(`no answer within ${timeoutMs} ms`);
  }
}

/** PKCE S256 code challenge (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function unanswered(request: AccessRequest, cause?: Error): AccessTimeoutError {
  return new AccessTimeoutError(
    `Nobody answered Beeper's approval box within ${describeWait(request.timeoutMs)}. Run this again when you can approve it.`,
    { cause },
  );
}

function describeWait(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

function isApiDisabled(res: HttpResponse): boolean {
  try {
    return res.status === 404 && ApiDisabled.safeParse(JSON.parse(res.body)).success;
  } catch {
    return false;
  }
}

function parseJson<T>(schema: z.ZodType<T>, body: string, what: string): T {
  try {
    return schema.parse(JSON.parse(body));
  } catch (err) {
    throw new ProviderError(`Beeper sent an unexpected ${what}: ${(err as Error).message}`, { cause: err });
  }
}

/** Beeper reports authorize-page errors as HTML; reduce it to its words. */
function pageText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || '(empty response)';
}
