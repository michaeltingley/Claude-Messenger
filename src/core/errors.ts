/** Base class for all Claude Messenger errors. */
export class MessengerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The provider endpoint could not be reached at all. */
export class ConnectionError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'connection_failed', options);
  }
}

/** The provider rejected our credentials. */
export class AuthError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'auth_failed', options);
  }
}

export class NotFoundError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'not_found', options);
  }
}

/** Any other provider-side failure, with the upstream error as `cause`. */
export class ProviderError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'provider_error', options);
  }
}

/**
 * A watch was asked to catch up on more messages than it takes at once. It
 * fails rather than skip any; watching from a later time asks for fewer.
 */
export class BacklogTooLargeError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'backlog_too_large', options);
  }
}

/** The owner declined the provider's approval prompt for this app's credential. */
export class AccessDeniedError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'access_denied', options);
  }
}

/**
 * The owner approved, but on terms this app can't keep (more access than it
 * asked for, or an expiry). The credential was revoked, or the message says
 * how to revoke it.
 */
export class AccessMismatchError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'access_mismatch', options);
  }
}

/** Nobody signed in to the provider, or answered its approval prompt, in time. */
export class AccessTimeoutError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'access_timeout', options);
  }
}

/** The language model gave no answer: it is missing, signed out, failed or too slow. */
export class ModelError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'model_failed', options);
  }
}

/** An action was blocked by the local policy layer (never by the provider). */
export class PolicyDeniedError extends MessengerError {
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message, 'policy_denied');
  }
}

/**
 * A sign-up's address already has an account. Signing up never keeps an
 * endpoint signed in to one; the message says whether it was signed out.
 */
export class AccountExistsError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'account_exists', options);
  }
}
