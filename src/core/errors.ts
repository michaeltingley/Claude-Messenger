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

/** An action was blocked by the local policy layer (never by the provider). */
export class PolicyDeniedError extends MessengerError {
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message, 'policy_denied');
  }
}
