import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessRequester } from '../src/app.js';
import type { AccessProgress, AccessRequest } from '../src/core/access.js';
import {
  AccessDeniedError,
  AccessMismatchError,
  AccessTimeoutError,
  AuthError,
  ConnectionError,
  ProviderError,
} from '../src/core/errors.js';
import { BeeperAccessRequester, s256 } from '../src/providers/beeper/access.js';
import { BeeperMessenger } from '../src/providers/beeper/index.js';
import { MockBeeperServer, wireChat } from './mock-beeper.js';

/**
 * Integration: BeeperAccessRequester over real HTTP against the mock's model
 * of Beeper Desktop 4.3.176's OAuth server and approval box, including what
 * a person at the box can do: approve on any terms, decline, or not answer
 * until Beeper closes the box itself. The adapter reports the terms the owner
 * approved; whether the app keeps them is GuardedAccessRequester's call
 * (access-guard.test.ts), proven here once through the composition root.
 */
describe('BeeperAccessRequester (HTTP integration)', () => {
  let mock: MockBeeperServer;
  let baseUrl: string;
  let requester: BeeperAccessRequester;
  let progress: AccessProgress[];

  const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => ({
    clientName: 'Claude Messenger',
    write: false,
    timeoutMs: 20_000,
    onProgress: (p) => progress.push(p),
    ...overrides,
  });

  const oauthCalls = () => mock.requests.filter((r) => r.path.startsWith('/oauth/'));
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(condition()).toBe(true);
  };

  beforeEach(async () => {
    mock = new MockBeeperServer();
    baseUrl = await mock.start();
    mock.chats = [wireChat()];
    requester = new BeeperAccessRequester({ baseUrl });
    progress = [];
  });

  afterEach(async () => {
    await mock.stop();
  });

  describe('approval', () => {
    it('returns the read-only token the owner approved, and it works against the API', async () => {
      const grant = await requester.requestAccess(request());

      expect(grant.write).toBe(false);
      expect(mock.issuedTokens.get(grant.token)).toEqual({ scope: 'read', revoked: false });
      const accounts = await new BeeperMessenger({ baseUrl, accessToken: grant.token, maxRetries: 0 }).listAccounts();
      expect(accounts.map((a) => a.id)).toEqual(['whatsapp-1']);
      expect(progress).toEqual([{ kind: 'approval-requested', attempt: 1 }]);
    });

    it("asks Beeper's box for exactly what was requested, under this app's name and PKCE S256", async () => {
      await requester.requestAccess(request());

      expect(mock.approvalRequests).toHaveLength(1);
      const asked = mock.approvalRequests[0]!;
      expect(asked).toMatchObject({
        clientInfo: { name: 'Claude Messenger' },
        scopes: ['read'],
        codeChallengeMethod: 'S256',
      });
      // A SHA-256 challenge, never the verifier itself; the mock's token
      // endpoint only issued the token because the verifier matched it.
      expect(asked.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('asks for write access only when told to, and reports it granted', async () => {
      const grant = await requester.requestAccess(request({ write: true }));

      expect(mock.approvalRequests[0]?.scopes).toEqual(['read', 'write']);
      expect(grant.write).toBe(true);
      expect(mock.issuedTokens.get(grant.token)?.scope).toBe('read write');
    });

    it('keeps a token narrower than asked, reporting that it cannot write', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read'] });

      const grant = await requester.requestAccess(request({ write: true }));

      expect(grant.write).toBe(false);
      expect(mock.issuedTokens.get(grant.token)?.revoked).toBe(false);
    });

    it('revokes the token on request, after which Beeper no longer accepts it', async () => {
      const grant = await requester.requestAccess(request());

      await grant.revoke();

      expect(mock.issuedTokens.get(grant.token)?.revoked).toBe(true);
      await expect(
        new BeeperMessenger({ baseUrl, accessToken: grant.token, maxRetries: 0 }).listAccounts(),
      ).rejects.toThrow(AuthError);
    });
  });

  describe('the terms the owner approved', () => {
    it('reports write access granted unasked, without deciding about it', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read', 'write'] });

      const grant = await requester.requestAccess(request());

      expect(grant.write).toBe(true);
      expect(mock.issuedTokens.get(grant.token)).toEqual({ scope: 'read write', revoked: false });
    });

    it('reports when the token expires', async () => {
      mock.decide = () => ({ approve: true, expiresInSeconds: 30 * 24 * 3600 });

      const before = Date.now();
      const grant = await requester.requestAccess(request());

      expect(grant.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 24 * 3600 * 1000);
      expect(grant.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 24 * 3600 * 1000);
    });

    it('counts a scope it does not know as write access, never as less', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read', 'admin'] });

      const grant = await requester.requestAccess(request());

      expect(grant.write).toBe(true);
    });

    it('reports no expiry when the owner chose Never', async () => {
      const grant = await requester.requestAccess(request());

      expect(grant.expiresAt).toBeUndefined();
    });

    it('is refused and revoked at Beeper when the app is wired as connect gets it', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read', 'write'], expiresInSeconds: 3600 });

      const error = await createAccessRequester({ beeperBaseUrl: baseUrl })
        .requestAccess(request())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessMismatchError);
      const [[token, issued]] = [...mock.issuedTokens.entries()];
      expect(issued).toEqual({ scope: 'read write', revoked: true });
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain('It was revoked, and nothing was saved.');
    });
  });

  describe('token responses OAuth allows but Beeper 4.3.176 does not send', () => {
    it('reads a scope left out as the scope asked for', async () => {
      mock.shapeTokenResponse = ({ scope: _, ...rest }) => ({ status: 200, body: rest });

      expect((await requester.requestAccess(request())).write).toBe(false);
      expect((await requester.requestAccess(request({ write: true }))).write).toBe(true);
    });

    it('reads expires_in sent as a string of digits', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 200, body: { ...body, expires_in: '3600' } });

      const grant = await requester.requestAccess(request());

      expect(grant.expiresAt!.getTime() - Date.now()).toBeGreaterThan(3_590_000);
    });

    it('keeps a token issued under another success status', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 201, body });

      const grant = await requester.requestAccess(request());

      expect(mock.issuedTokens.get(grant.token)?.revoked).toBe(false);
    });

    it('revokes a token whose terms it cannot read, and says so without quoting it', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 200, body: { ...body, scope: 42 } });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toBe('Beeper sent an unexpected token response (scope). The token was revoked.');
      expect([...mock.issuedTokens.values()]).toEqual([{ scope: 'read', revoked: true }]);
    });

    it('says where to revoke a token it could not read, when Beeper will not revoke it', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 200, body: { ...body, scope: 42 } });
      mock.revokeFails = true;

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error.message).toBe(
        'Beeper sent an unexpected token response (scope). ' +
          'The token still works until you revoke it in Beeper, under Settings → Integrations → Approved connections.',
      );
      expect([...mock.issuedTokens.values()].map((t) => t.revoked)).toEqual([false]);
    });

    it('revokes a token with a lifetime too long to represent', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 200, body: { ...body, expires_in: 1e300 } });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('expires_in is out of range');
      expect([...mock.issuedTokens.values()].map((t) => t.revoked)).toEqual([true]);
    });

    it('never quotes a failed token response, which can carry the token', async () => {
      mock.shapeTokenResponse = (body) => ({ status: 500, body });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error.message).toBe('Beeper could not exchange the approval for a token (HTTP 500).');
      expect(error.message).not.toContain([...mock.issuedTokens.keys()][0]);
    });
  });

  describe('waiting for a person', () => {
    it('waits for an account to be signed in before opening the box', async () => {
      mock.signedIn = false;

      const pending = requester.requestAccess(request());
      await until(() => mock.requests.filter((r) => r.path === '/v1/app/setup').length >= 2);
      expect(oauthCalls()).toEqual([]);
      mock.signedIn = true;
      const grant = await pending;

      expect(mock.issuedTokens.has(grant.token)).toBe(true);
      expect(progress).toEqual([
        { kind: 'action-required', step: 'Sign in to Beeper with your emailed code.' },
        { kind: 'approval-requested', attempt: 1 },
      ]);
    });

    it("waits for Beeper's Desktop API to be switched on, then for sign-in, saying each step once", async () => {
      mock.apiDisabled = true;
      mock.signedIn = false;
      const setupChecks = () => mock.requests.filter((r) => r.path === '/v1/app/setup').length;

      const pending = requester.requestAccess(request());
      await until(() => setupChecks() >= 2);
      mock.apiDisabled = false;
      const switchedOn = setupChecks();
      await until(() => setupChecks() >= switchedOn + 2);
      expect(oauthCalls()).toEqual([]);
      mock.signedIn = true;
      await pending;

      expect(progress).toEqual([
        {
          kind: 'action-required',
          step: "Beeper's Desktop API is switched off. Turn it on in Beeper, under Settings → Integrations → Beeper Desktop API.",
        },
        { kind: 'action-required', step: 'Sign in to Beeper with your emailed code.' },
        { kind: 'approval-requested', attempt: 1 },
      ]);
    }, 15_000);

    it('gives up when the Desktop API stays switched off, saying where to turn it on', async () => {
      mock.apiDisabled = true;

      const error = await requester.requestAccess(request({ timeoutMs: 1_000 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessTimeoutError);
      expect((error as Error).message).toBe(
        "Beeper's Desktop API stayed switched off for 1 s. Turn it on under Settings → Integrations → Beeper Desktop API, then run this again.",
      );
    });

    it('gives up when nobody signs in in time, without asking Beeper for anything', async () => {
      mock.signedIn = false;

      const error = await requester.requestAccess(request({ timeoutMs: 1_000 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessTimeoutError);
      expect((error as Error).message).toContain('Nobody signed in to Beeper within 1 s');
      expect(oauthCalls()).toEqual([]);
    });

    it('opens a fresh box when Beeper closes one nobody answered', async () => {
      // Beeper's two minutes, shortened on both sides.
      mock.boxLifetimeMs = 1_500;
      requester = new BeeperAccessRequester({ baseUrl, boxLifetimeMs: 1_500 });
      let boxes = 0;
      mock.decide = () => (++boxes === 1 ? 'no-answer' : { approve: true });

      const grant = await requester.requestAccess(request());

      expect(mock.approvalRequests).toHaveLength(2);
      expect(mock.issuedTokens.has(grant.token)).toBe(true);
      expect(progress).toEqual([
        { kind: 'approval-requested', attempt: 1 },
        { kind: 'approval-requested', attempt: 2 },
      ]);
    }, 15_000);

    it('stops at its own deadline even while Beeper keeps closing unanswered boxes', async () => {
      mock.boxLifetimeMs = 3_500;
      requester = new BeeperAccessRequester({ baseUrl, boxLifetimeMs: 3_500 });
      mock.decide = () => 'no-answer';
      const started = Date.now();

      const error = await requester.requestAccess(request({ timeoutMs: 5_000 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessTimeoutError);
      // The second box gets what is left of the five seconds, not another five.
      expect(Date.now() - started).toBeLessThan(6_500);
      expect(mock.approvalRequests).toHaveLength(2);
      await until(() => mock.openBoxes === 0);
    }, 15_000);

    it('gives up at its own deadline while the box is still open', async () => {
      mock.decide = () => 'no-answer';

      const error = await requester.requestAccess(request({ timeoutMs: 1_000 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessTimeoutError);
      expect((error as Error).message).toContain("Nobody answered Beeper's approval box within 1 s");
      expect(mock.issuedTokens.size).toBe(0);
    });

    it('stops at a decline, without asking again', async () => {
      mock.decide = () => ({ approve: false });

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as Error).message).toContain('press Approve');
      expect(mock.approvalRequests).toHaveLength(1);
      expect(mock.issuedTokens.size).toBe(0);
    });
  });

  describe('failures', () => {
    it('reports Beeper failing to open the box, instead of asking again', async () => {
      mock.decide = () => ({ approve: false, error: 'server_error' });

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain('could not ask for approval (server_error)');
      expect(mock.approvalRequests).toHaveLength(1);
    });

    it("passes on Beeper's own reason when it cannot ask", async () => {
      mock.decide = () => ({ approve: false, error: 'server_error', description: 'No window to show the request in' });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('could not ask for approval (server_error: No window to show the request in)');
    });

    it("passes on Beeper's own reason when it will not issue the token", async () => {
      mock.shapeTokenResponse = () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' },
      });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      expect(error.message).toBe(
        'Beeper could not exchange the approval for a token (HTTP 400): invalid_grant: Invalid or expired authorization code',
      );
    });

    it('refuses an approval that answers some other request, exchanging nothing', async () => {
      mock.decide = () => ({ approve: true, state: 'another-request' });

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain('state mismatch');
      expect(oauthCalls().map((r) => r.path)).not.toContain('/oauth/token');
      expect(mock.issuedTokens.size).toBe(0);
    });

    it("reports what Beeper's consent page refuses, without opening a box", async () => {
      mock.refuseAuthorize = 'Requested scope exceeds registered scope for this client.';

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toMatch(
        /^Beeper could not start the approval \(HTTP 400\): .*Requested scope exceeds registered scope for this client\.$/,
      );
      expect(mock.approvalRequests).toEqual([]);
    });

    it("says to turn Beeper's API back on when it goes off partway", async () => {
      // The person approves, then switches the API off before the token is fetched.
      mock.decide = () => {
        mock.apiDisabled = true;
        return { approve: true };
      };

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toBe(
        "Beeper Desktop's API is switched off, so it cannot exchange the approval for a token. " +
          'Turn it on under Settings → Integrations → Beeper Desktop API, then run this again.',
      );
      expect(mock.issuedTokens.size).toBe(0);
    });

    it("refuses a sign-in answer that is not Beeper's, instead of waiting on it", async () => {
      const impostor: Server = createServer((_req, res) => res.end('<html>a router login page</html>'));
      await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve));
      const { port } = impostor.address() as AddressInfo;
      try {
        const error = await new BeeperAccessRequester({ baseUrl: `http://127.0.0.1:${port}` })
          .requestAccess(request())
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProviderError);
        expect((error as Error).message).toBe(
          'Beeper could not say whether it is signed in (HTTP 200): a router login page',
        );
      } finally {
        await new Promise((resolve) => impostor.close(resolve));
      }
    });

    it('works behind a base URL with a path prefix', async () => {
      mock.pathPrefix = '/beeper';

      const grant = await new BeeperAccessRequester({ baseUrl: `${baseUrl}/beeper/` }).requestAccess(request());

      expect(mock.issuedTokens.get(grant.token)?.revoked).toBe(false);
      expect(mock.requests.map((r) => r.path)).toContain('/oauth/token');
    });

    it('points to minting a token by hand when Beeper has no OAuth server', async () => {
      mock.oauthEnabled = false;

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain('has no OAuth server');
      expect((error as Error).message).toContain('Approved connections');
    });

    it('fails as a connection error when Beeper Desktop is not running', async () => {
      const offline = new BeeperAccessRequester({ baseUrl: 'http://127.0.0.1:1' });

      const error = await offline.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toContain('Cannot reach Beeper Desktop at http://127.0.0.1:1');
    });
  });

  describe('instructions', () => {
    it("walk the person through Beeper's box, matching what is asked for", () => {
      const readOnly = requester.instructions(request()).join('\n');
      const withSend = requester.instructions(request({ write: true })).join('\n');

      expect(readOnly).toContain('Expires in: choose Never');
      expect(readOnly).toContain('Allow sensitive actions: leave it off');
      expect(withSend).toContain('Allow sensitive actions: turn it on');
      expect(readOnly).toContain('"Approve connection" box for Claude Messenger');
      // In the order Beeper asks: the box opens right after the emailed code, before the recovery key.
      expect(readOnly).toMatch(/emailed code[\s\S]*"Approve connection"[\s\S]*Press Approve[\s\S]*recovery key, enter it/);
    });
  });
});

describe('PKCE', () => {
  it('derives the S256 challenge exactly as RFC 7636 Appendix B does', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
