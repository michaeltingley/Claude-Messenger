/**
 * The provider-agnostic port for obtaining this app's credential.
 *
 * A credential must reach the host without passing through a terminal, a
 * chat or a screen, because a Claude session drives the install and its
 * transcript is readable. So the only supported way in is the provider's
 * own approval prompt: the owner approves there, and the credential travels
 * straight from the provider to this process.
 *
 * Implementations live under `providers/`; the CLI gets one from the
 * composition root and never learns which provider it talks to.
 */
export interface AccessRequester {
  /**
   * What the person will do in the provider's own window, in order. The
   * caller shows it before waiting, so whoever relays it to the person has
   * everything at once.
   */
  instructions(request: AccessRequest): readonly string[];

  /**
   * Ask the provider for a credential and wait, until `timeoutMs` runs out,
   * for an account to be signed in and the owner to decide.
   *
   * Resolves only with a credential this app can keep: write access only if
   * asked for, and no expiry, since nothing here renews one. Rejects with
   * `AccessDeniedError` if the owner declines, `AccessMismatchError` if they
   * approve on other terms (that credential is revoked first), and
   * `AccessTimeoutError` if the time runs out.
   */
  requestAccess(request: AccessRequest): Promise<AccessGrant>;
}

export interface AccessRequest {
  /** What the provider's approval prompt calls this app. */
  clientName: string;
  /**
   * Also ask for write access (sending, marking read). Off by default, like
   * the policy: a read-only credential is a second lock that holds even if
   * the policy layer is bypassed.
   */
  write: boolean;
  /** How long to wait in all, for sign-in and for the owner's decision. */
  timeoutMs: number;
  /** Told as the wait moves on, so the caller can say what is happening. */
  onProgress?: (progress: AccessProgress) => void;
}

export type AccessProgress =
  /** The provider has no signed-in account yet; the person signs in first. */
  | { kind: 'sign-in-required' }
  /**
   * The approval prompt is open. From the second attempt on, the provider
   * closed an unanswered prompt and this is a fresh one.
   */
  | { kind: 'approval-requested'; attempt: number };

export interface AccessGrant {
  /** The credential. Never print or log it; it is equivalent to the account. */
  readonly token: string;
  /** Whether it can write. It may not, even if asked: the owner can withhold that. */
  readonly write: boolean;
  /** Invalidate this credential at the provider, e.g. when it could not be stored. */
  revoke(): Promise<void>;
}
