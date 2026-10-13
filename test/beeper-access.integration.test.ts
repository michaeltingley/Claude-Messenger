import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * until Beeper closes the box itself.
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

  describe('terms this app cannot keep', () => {
    it('revokes and refuses write access the owner granted unasked', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read', 'write'] });

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessMismatchError);
      expect((error as Error).message).toContain('leave Allow sensitive actions off');
      expect((error as Error).message).toContain('It was revoked and nothing was saved');
      const [issued] = [...mock.issuedTokens.values()];
      expect(issued).toEqual({ scope: 'read write', revoked: true });
    });

    it('revokes and refuses a token that expires, since nothing here renews it', async () => {
      mock.decide = () => ({ approve: true, expiresInSeconds: 30 * 24 * 3600 });

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessMismatchError);
      expect((error as Error).message).toContain('choose Never under Expires in');
      expect([...mock.issuedTokens.values()].map((t) => t.revoked)).toEqual([true]);
    });

    it('never puts the refused token in its error', async () => {
      mock.decide = () => ({ approve: true, scopes: ['read', 'write'], expiresInSeconds: 3600 });

      const error = (await requester.requestAccess(request()).catch((e: unknown) => e)) as Error;

      const [token] = [...mock.issuedTokens.keys()];
      expect(error.message).not.toContain(token);
      // Both problems named, and both fixes.
      expect(error.message).toMatch(/leave Allow sensitive actions off, and choose Never under Expires in/);
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
      expect(progress).toEqual([{ kind: 'sign-in-required' }, { kind: 'approval-requested', attempt: 1 }]);
    });

    it('gives up when nobody signs in in time, without asking Beeper for anything', async () => {
      mock.signedIn = false;

      const error = await requester.requestAccess(request({ timeoutMs: 1_000 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessTimeoutError);
      expect((error as Error).message).toContain('Nobody signed in to Beeper within 1 s');
      expect(oauthCalls()).toEqual([]);
    });

    it('opens a fresh box when Beeper closes one nobody answered', async () => {
      // Beeper's two minutes, shortened; still long enough to be a closed box, not a fault.
      mock.boxLifetimeMs = 3_500;
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

    it("says to turn Beeper's API on when it is switched off", async () => {
      mock.apiDisabled = true;

      const error = await requester.requestAccess(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain("Beeper Desktop's API is switched off");
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
    });
  });
});

describe('PKCE', () => {
  it('derives the S256 challenge exactly as RFC 7636 Appendix B does', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
