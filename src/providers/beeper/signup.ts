import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { AccountSignup, AccountTerms, NewAccount, SignupRequest } from '../../core/signup.js';
import { AccountExistsError, ConnectionError, ProviderError } from '../../core/errors.js';
import { parseJson, parseOrUndefined } from './json.js';

/**
 * Creates a Beeper account through the setup API of the Beeper endpoint that
 * will run it: Beeper Server, for the assistant's own account
 * (deploy/assistant-beeper.sh).
 *
 * What Beeper Server 4.3.176 (Client API 5.0.0) does here, from its OpenAPI
 * spec and its answers:
 * - POST /v1/app/setup/start opens a setup request (sign-in methods
 *   `["email"]`), and POST /v1/app/setup/email has Beeper email it a code.
 *   Like /response and /register, they take no token: they are how one comes
 *   to exist.
 * - GET /v1/app/setup answers 200 while signed out, and 401 to a request
 *   without a token once an account is signed in. With the token, it reports
 *   how far encryption setup has come, up to `ready`.
 * - POST /v1/app/setup/response with the code signs the endpoint in to the
 *   address's account, answering with its token, if it has one. If it has
 *   none, it answers `registrationRequired` with a lead token and username
 *   suggestions, and POST /v1/app/setup/register creates the account, signs
 *   the endpoint in and answers with its token.
 * - Beeper sets a new account's encryption up by itself. At the assistant's
 *   sign-up (2026-10-14) it reported `initializing`, then `needs-secrets`,
 *   `needs-first-sync` and `ready`, with nothing asked of the client.
 * - POST /v1/app/setup/verification/recovery-key/reset makes a recovery key,
 *   and /reset/confirm puts it in use, setting encryption up afresh: how an
 *   account Beeper reports as having none (`needs-cross-signing-setup`) gets
 *   some. On an account with chat networks connected, that can disconnect
 *   them (Beeper's maintainer, on beeper/cli#21).
 * - The token is the account's Matrix access token: POST
 *   `<homeserver>/_matrix/client/v3/logout` signs it out.
 */

/** Bound on every request. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How often to ask how far encryption setup has come. */
const POLL_MS = 1_000;

/** The bridge type of Beeper's own chat network. Every other one is a connected chat network. */
const BEEPER_NETWORK = 'matrix';

const SetupStart = z.object({ setupRequestID: z.string().min(1), signInMethods: z.array(z.string()) });

const Credentials = z.object({
  userID: z.string().min(1),
  deviceID: z.string(),
  accessToken: z.string().min(1),
  homeserver: z.string().url(),
});
type Credentials = z.infer<typeof Credentials>;

/** The endpoint signed in: the account's credentials. */
const SignedIn = z.object({ matrix: Credentials });

/** The address has no account yet: what creating one takes. */
const RegistrationRequired = z.object({
  registrationRequired: z.literal(true),
  setupRequestID: z.string().min(1),
  leadToken: z.string().min(1),
  usernameSuggestions: z.array(z.string()).optional(),
});

const SetupState = z.object({ state: z.string() });

const NewRecoveryKey = z.object({ recoveryKey: z.string().min(1) });

const Accounts = z.array(
  z.object({ accountID: z.string(), network: z.string().optional(), bridge: z.object({ type: z.string() }) }),
);

/**
 * Beeper's error body. Only its message is ever quoted: never a success
 * body, which can hold a token, nor the answer to the request that sends the
 * recovery key back, in case it quotes what it was sent.
 */
const ApiError = z.object({ message: z.string() });

/** The account has never had encryption: setting it up afresh, with a new recovery key, is how it gets one. */
const NO_ENCRYPTION = 'needs-cross-signing-setup';

/**
 * The account set its encryption up before, on another device: this one
 * must be let in to it, with the recovery key or from a device already in.
 * Setting it up afresh would cut the account off from what it protects.
 */
const EXISTING_ENCRYPTION = 'needs-verification';

/**
 * States Beeper moves on from by itself. `needs-secrets` is one: a new
 * account passes through it while Beeper sets its encryption up. Waiting on
 * it changes nothing, whichever account it is.
 */
const IN_PROGRESS = new Set(['initializing', 'needs-secrets', 'needs-first-sync']);

export interface BeeperAccountSignupOptions {
  /** The Beeper endpoint the account will run on, as in `BeeperMessengerOptions.baseUrl`. */
  baseUrl: string;
}

export class BeeperAccountSignup implements AccountSignup {
  private readonly baseUrl: string;

  constructor(options: BeeperAccountSignupOptions) {
    // Paths are appended, as the SDK does, so a base URL with a path prefix works.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async sendCode(email: string): Promise<SignupRequest> {
    const setup = await this.send('GET', '/v1/app/setup');
    if (setup.status === 401 || setup.status === 403) {
      throw new ProviderError(
        `Beeper at ${this.baseUrl} is signed in to an account already, so there is nothing to sign up here; ` +
          'nothing was emailed. Sign up only on a Beeper endpoint of its own that is signed out.',
      );
    }
    if (setup.status !== 200) throw failure('say whether it is signed in', setup);
    const { state } = parseJson(SetupState, setup.body, 'setup state');
    if (state !== 'needs-login') {
      throw new ProviderError(`Beeper at ${this.baseUrl} is not signed out (it reports "${state}"); nothing was emailed.`);
    }

    const start = await this.send('POST', '/v1/app/setup/start');
    if (start.status !== 200) throw failure('start a sign-up', start);
    const request = parseJson(SetupStart, start.body, 'answer to starting a sign-up');
    if (!request.signInMethods.includes('email')) {
      throw new ProviderError(
        `Beeper offers no sign-up by email here (it offers: ${request.signInMethods.join(', ') || 'nothing'}).`,
      );
    }
    const sent = await this.send('POST', '/v1/app/setup/email', { json: { setupRequestID: request.setupRequestID, email } });
    if (!succeeded(sent)) throw failure('email a sign-up code', sent);
    return { id: request.setupRequestID };
  }

  async createAccount(request: SignupRequest, code: string, terms: AccountTerms): Promise<NewAccount> {
    const answer = await this.send('POST', '/v1/app/setup/response', {
      json: { setupRequestID: request.id, response: code },
    });
    // Any success: an answer that signed the endpoint in must be read, whatever its status.
    if (!succeeded(answer)) throw failure('accept the code', answer);
    await this.refuseExistingAccount(answer.body);

    const registration = parseJson(RegistrationRequired, answer.body, 'answer to the code');
    const username = terms.username ?? registration.usernameSuggestions?.[0];
    if (username === undefined) {
      throw new ProviderError('Beeper suggested no username for the new account; give one.');
    }
    const created = await this.send('POST', '/v1/app/setup/register', {
      json: {
        setupRequestID: registration.setupRequestID,
        leadToken: registration.leadToken,
        username,
        acceptTerms: terms.acceptTerms,
      },
    });
    if (!succeeded(created)) throw failure(`create the account ${username}`, created);
    const { matrix } = parseJson(SignedIn, created.body, 'new account');
    return { token: matrix.accessToken, userId: matrix.userID, signOut: () => this.signOut(matrix) };
  }

  async setUpEncryption(
    token: string,
    options: { timeoutMs: number; onProgress?: (step: string) => void },
  ): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    let told: string | undefined;
    let reset = false;
    for (;;) {
      const setup = await this.send('GET', '/v1/app/setup', { token });
      if (setup.status !== 200) throw failure('say how far its setup has come', setup);
      const { state } = parseJson(SetupState, setup.body, 'setup state');
      if (state === 'ready') return;
      if (state !== told) options.onProgress?.(describeState(state));
      told = state;

      // Once is enough: still needing encryption after a reset Beeper
      // accepted is something to report, not a reason to reset again.
      if (reset && (state === NO_ENCRYPTION || state === EXISTING_ENCRYPTION)) {
        throw new ProviderError(`Beeper still reports "${state}" after its encryption was set up.`);
      }
      if (state === NO_ENCRYPTION) {
        await this.requireNoChatNetworks(token);
        await this.resetEncryption(token);
        reset = true;
      } else if (state === EXISTING_ENCRYPTION) {
        throw new ProviderError(
          `This account set up its encryption before, elsewhere (Beeper reports "${state}"), so it is not set ` +
            'up afresh here: that would cut the account off from what it protects. Let this device in to it in ' +
            "Beeper, with the account's recovery key.",
        );
      } else if (!IN_PROGRESS.has(state)) {
        throw new ProviderError(`Beeper reports "${state}", from which this cannot set up encryption.`);
      }

      if (Date.now() + POLL_MS >= deadline) {
        throw new ProviderError(
          `Beeper had not finished setting up the account within ${Math.round(options.timeoutMs / 1000)} s ` +
            `(it reports "${state}"). What is done stays done.`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * An address that already has an account signs the endpoint in to it at
   * /response. That account may be the owner's, and is not this sign-up's to
   * keep, so it is signed out before anything else happens.
   */
  private async refuseExistingAccount(body: string): Promise<void> {
    const json = parseOrUndefined(body);
    if (typeof json !== 'object' || json === null || !('matrix' in json)) return;
    const remedy =
      'Sign up with another address, after deleting what Beeper here kept of that sign-in ' +
      "(for the assistant's runtime: deploy/assistant-beeper.sh --reset).";
    const signedIn = SignedIn.safeParse(json);
    if (!signedIn.success) {
      throw new AccountExistsError(
        'This address already has a Beeper account, and Beeper signed in to it here, but its answer was ' +
          `unreadable, so it could not be signed out: remove this device from that account in Beeper. ${remedy}`,
      );
    }
    const { matrix } = signedIn.data;
    const signedOut = await this.signOut(matrix).then(
      () => true,
      () => false,
    );
    throw new AccountExistsError(
      'This address already has a Beeper account, so nothing was created. Beeper signed in to it here on the way; ' +
        (signedOut
          ? 'it was signed out again at once. '
          : `signing it out failed: remove the device ${matrix.deviceID} from that account in Beeper. `) +
        remedy,
    );
  }

  /**
   * Resetting encryption can disconnect chat networks, so it happens only on
   * an account with none. Beeper's own network (`matrix`) is not one.
   */
  private async requireNoChatNetworks(token: string): Promise<void> {
    const res = await this.send('GET', '/v1/accounts', { token });
    if (res.status !== 200) throw failure("list the account's chat networks", res);
    const networks = parseJson(Accounts, res.body, 'account list')
      .filter((account) => account.bridge.type !== BEEPER_NETWORK)
      .map((account) => account.network ?? account.accountID);
    if (networks.length > 0) {
      throw new ProviderError(
        `This account has chat networks connected (${networks.join(', ')}), so its encryption is not set up ` +
          'afresh here: that can disconnect them. Set it up in Beeper, with its recovery key.',
      );
    }
  }

  /** A new recovery key, put in use at once and then forgotten: nothing here keeps or shows it. */
  private async resetEncryption(token: string): Promise<void> {
    const reset = await this.send('POST', '/v1/app/setup/verification/recovery-key/reset', { token, json: {} });
    if (reset.status !== 200) throw failure('set up encryption', reset);
    const { recoveryKey } = parseJson(NewRecoveryKey, reset.body, 'answer to setting up encryption');
    const confirmed = await this.send('POST', '/v1/app/setup/verification/recovery-key/reset/confirm', {
      token,
      json: { recoveryKey },
    });
    // Not failure(): an answer to a request carrying the key could echo it.
    if (confirmed.status !== 200) {
      throw new ProviderError(`Beeper could not put the new encryption in use (HTTP ${confirmed.status}).`);
    }
  }

  /** Signs a Matrix access token out at the account's homeserver, ending its session there. */
  private async signOut(credentials: Credentials): Promise<void> {
    const url = new URL(`${credentials.homeserver.replace(/\/+$/, '')}/_matrix/client/v3/logout`);
    const res = await this.fetch('POST', url, { token: credentials.accessToken, json: {} });
    // Not failure(): the homeserver answers this, not the Client API, and its
    // answer to a request carrying the token could echo it.
    if (res.status !== 200) throw new ProviderError(`Beeper could not sign the account out (HTTP ${res.status}).`);
  }

  private send(method: 'GET' | 'POST', path: string, options: { token?: string; json?: unknown } = {}) {
    return this.fetch(method, new URL(`${this.baseUrl}${path}`), options);
  }

  private async fetch(
    method: 'GET' | 'POST',
    url: URL,
    options: { token?: string; json?: unknown },
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.json !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      throw new ConnectionError(`Cannot reach Beeper at ${url.origin} (${(err as Error).message}).`, { cause: err });
    }
  }
}

function succeeded(res: { status: number }): boolean {
  return res.status >= 200 && res.status < 300;
}

/** An actionable error for an unexpected answer, quoting only an error body's message. */
function failure(action: string, res: { status: number; body: string }): ProviderError {
  const error = ApiError.safeParse(parseOrUndefined(res.body));
  return new ProviderError(
    `Beeper could not ${action} (HTTP ${res.status})${error.success ? `: ${error.data.message}` : '.'}`,
  );
}

/** What Beeper is doing, in the person's terms. */
function describeState(state: string): string {
  switch (state) {
    case 'initializing':
      return 'Beeper is starting the account...';
    case 'needs-secrets':
      return "Beeper is setting up the account's encryption...";
    case 'needs-first-sync':
      return 'Beeper is syncing the account for the first time...';
    default:
      return 'Setting up encryption...';
  }
}
