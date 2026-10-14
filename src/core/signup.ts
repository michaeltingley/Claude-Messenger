/**
 * The provider-agnostic port for creating an account of this app's own: the
 * one the @Claude assistant answers from, so nothing it says is ever sent as
 * the owner ("The assistant's own account" in docs/ARCHITECTURE.md).
 *
 * As with `AccessRequester` (core/access.ts), the account's credential never
 * passes through a terminal, a chat or a screen: it travels from the provider
 * straight to the caller, which saves it. Only the sign-up code the provider
 * emails passes through whoever relays it, and that code works once.
 *
 * Three things an implementation must never do, whatever it is asked: sign
 * up from an endpoint already signed in to an account, which could be the
 * owner's; keep an endpoint signed in to an account that existed before, as
 * an address the owner already uses would be; and set up afresh the
 * encryption of an account that had some already, or that has chat networks
 * connected: the first cuts it off from what its encryption protects, the
 * second can disconnect them.
 */
export interface AccountSignup {
  /**
   * Has the provider email a sign-up code to `email`. Refuses, emailing
   * nothing, unless the endpoint is signed out.
   */
  sendCode(email: string): Promise<SignupRequest>;

  /**
   * Creates the account with the emailed code, which signs the endpoint in to
   * it, and returns its credential. Signing up accepts the provider's terms,
   * so the caller must have the owner's word for that (`acceptTerms`).
   *
   * Rejects with `AccountExistsError` if the address already has an account.
   * The endpoint signs in to that account on the way, so it is signed out
   * again first, and nothing of it is returned.
   */
  createAccount(request: SignupRequest, code: string, terms: AccountTerms): Promise<NewAccount>;

  /**
   * Sets up the new account's end-to-end encryption, then waits, until
   * `timeoutMs` runs out, for the endpoint to be ready to read and send.
   * Safe to run again: it picks up where it stopped, and does nothing once
   * the account is ready. It refuses an account whose encryption was set up
   * before. The provider's recovery key, if it makes one, is never returned
   * or kept: the account has nothing a reset could lose.
   */
  setUpEncryption(token: string, options: { timeoutMs: number; onProgress?: (step: string) => void }): Promise<void>;
}

/** A sign-up in progress: the code is in the mail. */
export interface SignupRequest {
  /** The provider's ID for this sign-up, which finishing it needs. */
  readonly id: string;
}

export interface AccountTerms {
  /** The account's username. Left out, the provider's first suggestion. */
  username?: string;
  /** The owner agreed to the provider's terms for this account. */
  acceptTerms: true;
}

export interface NewAccount {
  /** The credential. Never print or log it; it is equivalent to the account. */
  readonly token: string;
  /** The account's ID, as the provider names it (`@claude:beeper.com`). */
  readonly userId: string;
  /** Signs this credential out, for when the caller cannot keep it. */
  signOut(): Promise<void>;
}
