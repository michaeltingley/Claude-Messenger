import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { AccessGrant, AccessProgress, AccessRequest, AccessRequester } from '../../core/access.js';
import { AccessDeniedError, AccessTimeoutError, ConnectionError, ProviderError } from '../../core/errors.js';

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
 * - With the "Beeper Desktop API" setting off, every route answers 404
 *   `disabled`. The person can switch it on in the same window, so this
 *   waits for that too.
 * - The callback answers `access_denied` when the owner declines. It answers
 *   `server_error` when Beeper closes a box nobody answered, two minutes in,
 *   and then this opens a fresh one, until its own deadline.
 * - The owner picks the token's lifetime and whether it may write, whatever
 *   was asked. This reports what they picked; GuardedAccessRequester decides
 *   whether the app keeps it.
 */

/**
 * Beeper requires a registered loopback redirect. Nothing is ever sent to it:
 * the code comes back in the callback's response.
 */
const REDIRECT_URI = 'http://127.0.0.1:47613/callback';

/** Bound on every request that doesn't wait for a person. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How often to check whether Beeper is ready to ask for approval. */
const READY_POLL_MS = 1_000;

/**
 * Beeper also answers `server_error` when it fails, whether before the box
 * opens or after the owner pressed Approve. Only an answer this far into the
 * box's lifetime means Beeper closed it unanswered; any sooner is a failure
 * to report, not a reason to open another box.
 */
const BOX_CLOSED_AFTER = 0.9;

const APPROVED_CONNECTIONS = 'Settings → Integrations → Approved connections';
const DESKTOP_API_SETTING = 'Settings → Integrations → Beeper Desktop API';

/** What the person does in Beeper's window before it can ask for approval. */
const READY_STEPS = {
  'switch-on-api': `Beeper's Desktop API is switched off. Turn it on in Beeper, under ${DESKTOP_API_SETTING}.`,
  // Only the code: the approval box opens next, before Beeper asks for the
  // recovery key (see instructions()).
  'sign-in': 'Sign in to Beeper with your emailed code.',
} as const;
type ReadyStep = keyof typeof READY_STEPS;

export interface BeeperAccessRequesterOptions {
  /** Beeper Client API endpoint, as in `BeeperMessengerOptions.baseUrl`. */
  baseUrl: string;
  /** How long Beeper keeps an approval box nobody answers open: two minutes in 4.3.176. */
  boxLifetimeMs?: number;
}

const RegisteredClient = z.object({ client_id: z.string().min(1) });

const Decision = z.object({
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
  state: z.string().optional(),
});

/** The token, read on its own first, so it can be revoked if the rest is unreadable. */
const IssuedToken = z.object({ access_token: z.string().min(1) });

/** The terms the owner approved the token on. */
const TokenTerms = z.object({
  /** Absent means the scope asked for (RFC 6749 §5.1). */
  scope: z.string().optional(),
  /** Seconds. Absent when the owner chose "Never" under "Expires in". */
  expires_in: z.union([z.number().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).nullish(),
});

const OAuthError = z.object({ error: z.string(), error_description: z.string().optional() });

/** Signed out, Beeper answers this without a token. */
const SetupState = z.object({ state: z.string() });

/** What Beeper answers on every route while its Desktop API is switched off. */
const ApiDisabled = z.object({ code: z.literal('disabled') });

type Progress = (progress: AccessProgress) => void;

export class BeeperAccessRequester implements AccessRequester {
  readonly revokeByHand = `in Beeper, under ${APPROVED_CONNECTIONS}`;
  private readonly baseUrl: string;
  private readonly boxLifetimeMs: number;

  constructor(options: BeeperAccessRequesterOptions) {
    // Paths are appended, as the SDK does, so a base URL with a path prefix works.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.boxLifetimeMs = options.boxLifetimeMs ?? 120_000;
  }

  instructions(request: AccessRequest): readonly string[] {
    return [
      "Approve the connection in Beeper's own window:",
      '  1. If Beeper asks you to sign in, enter your emailed code.',
      // Beeper opens it as soon as an account is signed in, which is before
      // the recovery key, and over whatever its window shows.
      `  2. Beeper then shows an "Approve connection" box for ${request.clientName}, even if it still wants your recovery key. In it:`,
      '     - Expires in: choose Never. A token that expires would stop working, and nothing here renews it.',
      request.write
        ? '     - Allow sensitive actions: turn it on, so sending can work.'
        : '     - Allow sensitive actions: leave it off.',
      '     - Press Approve.',
      '  3. If Beeper still asks for your recovery key, enter it.',
      '  If the box says the request has timed out, press Close; a new one follows.',
    ];
  }

  async requestAccess(request: AccessRequest): Promise<AccessGrant> {
    const deadline = Date.now() + request.timeoutMs;
    const progress: Progress = request.onProgress ?? (() => {});
    await this.awaitReady(request, deadline, progress);

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
    const body = await this.exchange(code, verifier, clientId);
    const token = parseJson(IssuedToken, body, 'token response').access_token;
    const revoke = () => this.revoke(token);
    // From here on a working token exists, so a failure must not leave it working.
    try {
      const terms = readTerms(body, scope);
      return { token, revoke, ...terms };
    } catch (err) {
      const revoked = await revoke().then(
        () => true,
        () => false,
      );
      throw new ProviderError(
        `${(err as Error).message} ` +
          (revoked ? 'The token was revoked.' : `The token still works until you revoke it ${this.revokeByHand}.`),
        { cause: err },
      );
    }
  }

  /**
   * Waits until Beeper can ask for approval: its Desktop API switched on, and
   * an account signed in, since the box grants access to it.
   */
  private async awaitReady(request: AccessRequest, deadline: number, progress: Progress): Promise<void> {
    let told: ReadyStep | undefined;
    for (;;) {
      const res = await this.send('GET', this.url('/v1/app/setup'));
      // Signed in, Beeper guards this route with a token, which this request doesn't carry.
      if (res.status === 401 || res.status === 403) return;
      let step: ReadyStep;
      if (isApiDisabled(res)) step = 'switch-on-api';
      else if (res.status === 200 && SetupState.safeParse(parseOrUndefined(res.body)).success) step = 'sign-in';
      else throw this.failure('say whether it is signed in', res);

      if (step !== told) progress({ kind: 'action-required', step: READY_STEPS[step] });
      told = step;
      if (Date.now() + READY_POLL_MS >= deadline) {
        const wait = describeWait(request.timeoutMs);
        throw new AccessTimeoutError(
          step === 'sign-in'
            ? `Nobody signed in to Beeper within ${wait}. Sign in on its screen, then run this again.`
            : `Beeper's Desktop API stayed switched off for ${wait}. Turn it on under ${DESKTOP_API_SETTING}, then run this again.`,
        );
      }
      await sleep(READY_POLL_MS);
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
      if (decision.error === 'server_error' && Date.now() - opened >= this.boxLifetimeMs * BOX_CLOSED_AFTER) continue;
      const reason = decision.error ?? 'it sent no code';
      throw new ProviderError(
        `Beeper could not ask for approval (${decision.error_description ? `${reason}: ${decision.error_description}` : reason}).`,
      );
    }
  }

  /**
   * Authorization code + PKCE verifier → the token response's body. Its
   * errors never quote the body, which can hold a token.
   */
  private async exchange(code: string, verifier: string, clientId: string): Promise<string> {
    const res = await this.send('POST', this.url('/oauth/token'), {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId },
    });
    // Any success, not only the 200 RFC 6749 names: a token issued under
    // another status must still be kept or revoked, never left working.
    if (res.status >= 200 && res.status < 300) return res.body;
    if (isApiDisabled(res)) throw this.failure('exchange the approval for a token', res);
    const err = OAuthError.safeParse(parseOrUndefined(res.body));
    throw new ProviderError(
      `Beeper could not exchange the approval for a token (HTTP ${res.status})` +
        (err.success ? `: ${err.data.error_description ? `${err.data.error}: ${err.data.error_description}` : err.data.error}` : '.'),
    );
  }

  private async revoke(token: string): Promise<void> {
    const res = await this.send('POST', this.url('/oauth/revoke'), {
      form: { token, token_type_hint: 'access_token' },
    });
    // Not failure(): an answer to a request carrying the token could echo it.
    if (res.status !== 200) throw new ProviderError(`Beeper could not revoke the token (HTTP ${res.status}).`);
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl}${path}`);
  }

  /** An actionable error for an unexpected answer. Never used for a body that can hold a token. */
  private failure(action: string, res: HttpResponse): ProviderError {
    if (isApiDisabled(res)) {
      return new ProviderError(
        `Beeper Desktop's API is switched off, so it cannot ${action}. Turn it on under ${DESKTOP_API_SETTING}, then run this again.`,
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

/**
 * What the owner approved, from the token response. Anything beyond read
 * counts as write: an unknown scope is assumed to grant more, never less.
 */
function readTerms(body: string, askedScope: string): { write: boolean; expiresAt?: Date } {
  const terms = parseJson(TokenTerms, body, 'token response');
  const write = (terms.scope ?? askedScope).split(' ').some((s) => s !== '' && s !== 'read');
  if (terms.expires_in == null) return { write };
  const expiresAt = new Date(Date.now() + terms.expires_in * 1000);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ProviderError('Beeper sent an unexpected token response: expires_in is out of range.');
  }
  return { write, expiresAt };
}

function isApiDisabled(res: HttpResponse): boolean {
  return res.status === 404 && ApiDisabled.safeParse(parseOrUndefined(res.body)).success;
}

function parseOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Parses a response body, naming only the fields that didn't fit: never the
 * values, since a token response's values include the token.
 */
function parseJson<S extends z.ZodTypeAny>(schema: S, body: string, what: string): z.output<S> {
  const parsed = schema.safeParse(parseOrUndefined(body));
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))].join(', ');
  throw new ProviderError(`Beeper sent an unexpected ${what} (${fields}).`);
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
