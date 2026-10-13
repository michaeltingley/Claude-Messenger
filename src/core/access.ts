/**
 * The provider-agnostic port for obtaining this app's credential.
 *
 * A credential must reach the host without passing through a terminal, a
 * chat or a screen, because a Claude session drives the install and its
 * transcript is readable. So the only supported way in is the provider's
 * own approval prompt: the owner approves there, and the credential travels
 * straight from the provider to this process.
 *
 * Implementations live under `providers/` and report what the owner granted.
 * Whether this app keeps it is decided above them, by
 * `GuardedAccessRequester` (policy/access.ts), which is the only requester
 * the CLI is ever handed.
 */
export interface AccessRequester {
  /**
   * What the person will do in the provider's own window, in order. The
   * caller shows it before waiting, so whoever relays it to the person has
   * everything at once.
   */
  instructions(request: AccessRequest): readonly string[];

  /** Where the owner revokes a credential by hand, in the provider's own words. */
  readonly revokeByHand: string;

  /**
   * Ask the provider for a credential and wait, until `timeoutMs` runs out,
   * for the provider to be ready to ask (an account signed in, say) and for
   * the owner to decide.
   *
   * Resolves with the credential on the terms the owner approved, which can
   * differ from the request. Rejects with `AccessDeniedError` if the owner
   * declines, and `AccessTimeoutError` if the time runs out.
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
  /**
   * The provider can't ask for approval until the person does something in
   * its window first, such as signing in. `step` says what, in the
   * provider's words. Told again whenever the step changes.
   */
  | { kind: 'action-required'; step: string }
  /**
   * The approval prompt is open. From the second attempt on, the provider
   * closed an unanswered prompt and this is a fresh one.
   */
  | { kind: 'approval-requested'; attempt: number };

export interface AccessGrant {
  /** The credential. Never print or log it; it is equivalent to the account. */
  readonly token: string;
  /** Whether it can write. The owner may withhold that, or grant it unasked. */
  readonly write: boolean;
  /** When it stops working, if the owner gave it a lifetime. */
  readonly expiresAt?: Date;
  /** Invalidate this credential at the provider, e.g. when it could not be stored. */
  revoke(): Promise<void>;
}
